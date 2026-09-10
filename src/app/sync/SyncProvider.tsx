import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createDriveSyncStore,
  createGoogleAuth,
  fetchAccountEmail,
  type GoogleAuth,
} from "../../adapters/google-drive-sync";
import { createSyncMetaStore } from "../../adapters/sync-meta-store";
import { holdsNoUserData } from "../../kernel/book-utils";
import { err } from "../../kernel/result";
import { errorMessage } from "../../service/error-messages";
import {
  applyFirstConnect,
  firstConnectOptions,
  inspectRemote,
  isChoiceOffered,
  type FirstConnectChoice,
  type LocalState,
} from "../../service/sync-connect";
import { createSyncEngine, type SyncEngine, type SyncState } from "../../service/sync-engine";
import type { SyncStorePort } from "../../ports/sync-store";
import type { Book } from "../../kernel";
import { useLedger } from "../ledger-context";
import {
  afterLocalStateChange,
  afterTeardown,
  IDLE,
  type ConnectStage,
} from "./pending-plan-rule";
import { SyncContext, type SyncContextValue } from "./sync-context";
import { runExclusive } from "./sync-lock";
import { syncSignal } from "./sync-signal";
import { shouldTearDown } from "./teardown-rule";

const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? "";

export function SyncProvider({ children }: { children: ReactNode }) {
  const { book, repo, announceBookChanged } = useLedger();
  const metaStore = useMemo(() => createSyncMetaStore(), []);
  const authRef = useRef<GoogleAuth | null>(null);
  const storeRef = useRef<SyncStorePort | null>(null);
  const engineRef = useRef<SyncEngine | null>(null);
  const fileIdRef = useRef<string | null>(null);
  // What `book` was on the previous run of the teardown effect below. `undefined` until
  // that effect has run once.
  const previousBookRef = useRef<Book | null | undefined>(undefined);
  const [connected, setConnected] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [state, setState] = useState<SyncState | null>(null);
  // Inspection, plan, the local state the plan was decided against, and "the plan was
  // dropped and the user has not been told yet", as one value: they are written and
  // cleared together, and no render may show one without the others.
  const [stage, setStage] = useState<ConnectStage>(IDLE);
  const [lastError, setLastError] = useState<string | null>(null);
  // The ref is the guard and the state is what the UI reads: a second tap arrives before
  // React has re-rendered with `applying`, so only a ref can turn it away.
  const applyingRef = useRef(false);
  const [applying, setApplying] = useState(false);

  const buildStore = useCallback((): SyncStorePort => {
    if (!authRef.current) authRef.current = createGoogleAuth(CLIENT_ID);
    if (!storeRef.current) {
      storeRef.current = createDriveSyncStore({
        // A cycle already inside the sync lock when `disconnect()` runs still holds this
        // store, and `disconnect()` clears `authRef` the moment it disposes the engine.
        // Asserting on that ref would throw inside the lock callback — an unhandled
        // rejection, since syncNow is invoked as `void engine.syncNow()` — or, a beat
        // earlier, write to Drive after the user believes they have disconnected. An
        // error Result fails that cycle through the engine's existing handling instead.
        getToken: async (interactive = false) => {
          const auth = authRef.current;
          if (!auth) return err<string>("SYNC_AUTH_REQUIRED", "Sync is not connected");
          return auth.getToken(interactive);
        },
        getFileId: () => fileIdRef.current,
        // The ref is set before the await so a second write in the same session sees
        // the new fileId and cannot create a duplicate file.
        onFileId: async (id) => {
          fileIdRef.current = id;
          await metaStore.save({ fileId: id });
        },
      });
    }
    return storeRef.current;
  }, [metaStore]);

  const startEngine = useCallback(() => {
    if (engineRef.current) return engineRef.current;
    const engine = createSyncEngine({
      repo,
      store: buildStore(),
      runExclusive,
      onBookChanged: announceBookChanged,
      onStateChanged: (next) => {
        setState(next);
        if (next.kind === "idle" && next.lastSyncAt !== null) {
          void metaStore.save({ lastSyncAt: next.lastSyncAt });
        }
      },
    });
    engineRef.current = engine;
    return engine;
  }, [repo, buildStore, announceBookChanged, metaStore]);

  // Resume a stored connection once the book is loaded.
  useEffect(() => {
    if (book === null || connected || !CLIENT_ID) return;
    let cancelled = false;
    void metaStore.load().then((meta) => {
      if (cancelled || !meta.connected) return;
      fileIdRef.current = meta.fileId;
      setEmail(meta.accountEmail);
      setConnected(true);
      setState({ kind: "idle", lastSyncAt: meta.lastSyncAt });
      void startEngine().syncNow();
    });
    return () => {
      cancelled = true;
    };
  }, [book, connected, metaStore, startEngine]);

  // Local commits nudge the engine; window events trigger opportunistic syncs.
  useEffect(() => {
    const unsubscribe = syncSignal.subscribe(() => engineRef.current?.notifyLocalChange());
    const onVisible = () => {
      if (document.visibilityState === "visible") void engineRef.current?.syncNow();
    };
    const onOnline = () => void engineRef.current?.syncNow();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      engineRef.current?.dispose();
    };
  }, []);

  const finalizeConnect = useCallback(async () => {
    const emailResult = await fetchAccountEmail((interactive = false) =>
      authRef.current!.getToken(interactive),
    );
    const accountEmail = emailResult.ok ? emailResult.value : null;
    await metaStore.save({ connected: true, accountEmail });
    setEmail(accountEmail);
    setConnected(true);
    setStage(IDLE);
    void startEngine().syncNow();
  }, [metaStore, startEngine]);

  /** Forget the cached Drive file id, in memory and on disk, so the next resolve
   * searches by name instead of 404ing on a dead one. Shared by `disconnect`, which
   * clears it as part of tearing everything down, and by the missing-file recovery,
   * which needs exactly this much and nothing else. */
  const forgetFile = useCallback(async () => {
    fileIdRef.current = null;
    await metaStore.save({ fileId: null });
  }, [metaStore]);

  /** Tear down this tab's connection: dispose the engine, drop the store/auth/file refs,
   * revoke the token, and persist "disconnected" to the shared sync-meta record. Shared
   * by `disconnect` (the user's own Settings action) and by the effect below (another
   * tab reset the book while this tab was still connected). Safe to run concurrently in
   * several tabs — each tab only touches its own in-memory refs and its own token, and
   * every tab's final write to the shared record agrees, so whichever write lands last
   * still leaves it correct. */
  const teardownConnection = useCallback(async () => {
    engineRef.current?.dispose();
    engineRef.current = null;
    storeRef.current = null;
    await forgetFile();
    await authRef.current?.revoke();
    authRef.current = null;
    await metaStore.save({ connected: false, accountEmail: null, lastSyncAt: null });
    setConnected(false);
    setEmail(null);
    setState(null);
    // Not an unconditional clear: this runs after three awaits, and in the "another tab
    // erased the book" case it lands after the drop notice is already on screen. See
    // `afterTeardown`.
    setStage(afterTeardown);
  }, [forgetFile, metaStore]);

  // Another tab's reset nulls the book here via the cross-tab broadcast, but that
  // broadcast never touches this tab's connection state directly — `connected`, the
  // engine and the refs are all per-tab. Left alone, this tab's engine stays alive
  // pointed at the old file: its next cycle fails BOOK_INVALID against the fresh empty
  // book, and if the user instead finishes onboarding in *this* tab, `afterCommit`
  // nudges the still-live engine, which merges the new book against the remote and
  // silently restores the old one. `pendingInspection` carries the same danger without
  // `connected` ever being true: `connect()` binds `storeRef`/`authRef`/`fileIdRef` to
  // the remote file the moment it inspects it, so a stale choice screen has "Replace
  // remote" wired to upload a freshly-onboarded seed over the real file.
  //
  // The condition is a transition, not a state — see `shouldTearDown`. A connection can
  // now *begin* while the book is null, because the onboarding and recovery screens
  // offer Connect, and tearing that down would destroy the choice as it appeared.
  //
  // This effect reads the *raw* `stage`, not the staleness-gated view below it. A plan
  // that has gone stale is still a store, an auth and a file id bound to the user's real
  // Drive file, and the transition is exactly the moment to let go of them. Hook order
  // matters here: this effect is declared before the one that commits the drop, so it
  // sees the `choosing` stage on the flush where the book vanished rather than a beat after.
  useEffect(() => {
    const previous = previousBookRef.current;
    previousBookRef.current = book;
    const pendingInspection = stage.kind === "choosing" ? stage.inspection : null;
    if (!shouldTearDown(previous, book, { connected, pendingInspection })) return;
    void teardownConnection().catch(() => {
      // `teardownConnection`'s first statement, `engineRef.current?.dispose()`, is
      // synchronous — the one danger this effect exists to close (a live engine
      // merging a fresh book against the old remote) is already shut by the time any
      // await here could reject. What a rejection (a thrown `revoke()`, say) leaves
      // behind is this tab's own `connected`/`pendingInspection` state not catching
      // up with the refs it already cleared — a display inconsistency, not a route
      // back to the file. This effect runs with no user action to attach a retry or
      // an error banner to (the book is null, so Settings is not even on screen), so
      // swallow rather than surface a message the user cannot act on.
    });
  }, [book, connected, stage, teardownConnection]);

  // What the local side has to lose. A null book covers both "storage is empty" and
  // "the stored book failed to load" — neither holds data a remote book could destroy.
  const localState: LocalState =
    book === null ? "none" : holdsNoUserData(book) ? "empty" : "real";

  // A plan is decided once, from the local state at the moment the remote was inspected —
  // that is what stops the choices shifting under the user's finger. The book can still
  // move underneath it, and then the plan describes a local side that no longer exists.
  // See `afterLocalStateChange` for the three ways that happens and what each one costs.
  //
  // Computed in render and merely committed by the effect: the effect is a passive one,
  // so a frame carrying the stale choices could otherwise reach the screen before it runs.
  // The transition returns its input object when nothing moved, so `!==` is the whole
  // change test.
  const liveStage = afterLocalStateChange(stage, localState, applying);
  useEffect(() => {
    if (liveStage !== stage) setStage(liveStage);
  }, [liveStage, stage]);
  const choosing = liveStage.kind === "choosing" ? liveStage : null;

  const connect = async () => {
    if (applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    try {
      setLastError(null);
      // The user did the thing the dropped-plan notice asks for, so the notice goes now
      // rather than when this connect lands — the button beside it is already disabled.
      setStage(IDLE);
      if (!authRef.current) authRef.current = createGoogleAuth(CLIENT_ID);
      const token = await authRef.current.getToken(true); // the tap satisfies the popup rule
      if (!token.ok) {
        setLastError(errorMessage(token.error.code));
        return;
      }
      const store = buildStore();
      const inspection = await inspectRemote(store);
      if (!inspection.ok) {
        setLastError(errorMessage(inspection.error.code));
        return;
      }
      const plan = firstConnectOptions(localState, inspection.value);
      if (plan.kind === "apply") {
        const applied = await applyFirstConnect(plan.choice, { repo, store, runExclusive });
        if (!applied.ok) {
          setLastError(errorMessage(applied.error.code));
          return;
        }
        await finalizeConnect();
        return;
      }
      // "choose" and "explain" both need the user to see the screen. `localState` here is
      // the value captured before the await above; stamping the plan with it is what lets
      // the gate above notice that the book moved while Drive was being read.
      setStage({ kind: "choosing", inspection: inspection.value, plan, plannedFor: localState });
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  };

  const value: SyncContextValue = {
    configured: CLIENT_ID !== "",
    connected,
    email,
    state,
    pendingInspection: choosing?.inspection ?? null,
    pendingPlan: choosing?.plan ?? null,
    pendingLocalState: choosing?.plannedFor ?? null,
    planWasDropped: liveStage.kind === "dropped",
    lastError,

    applying,

    connect,

    // What "the sync file is missing — reconnect to create it again" has always
    // promised, in one tap: drop the dead id, then run the connect flow. Never a blind
    // re-create — that flow inspects first, so a Drive that turns out to hold a book
    // after all (the file restored from the trash, say) reaches the choice UI instead
    // of being overwritten.
    reconnect: async () => {
      if (applyingRef.current) return;
      await forgetFile();
      await connect();
    },

    applyChoice: async (choice: FirstConnectChoice) => {
      // Act only on a choice the live plan actually offers. A tap carries a value that
      // was rendered from some earlier plan, and between the render and the handler the
      // plan can have been dropped as stale, cancelled, or replaced by a second Connect.
      // Running it anyway performs the write the current plan withheld — see
      // `isChoiceOffered`. The screens disable these buttons too; this is the half that
      // does not depend on every future screen remembering to.
      if (!isChoiceOffered(choosing?.plan ?? null, choice)) return;
      // The lock below serializes two of these; this turns the second one away entirely,
      // which is what a double-tapped choice button means.
      if (applyingRef.current) return;
      applyingRef.current = true;
      setApplying(true);
      try {
        setLastError(null);
        const applied = await applyFirstConnect(choice, {
          repo,
          store: buildStore(),
          runExclusive,
        });
        if (!applied.ok) {
          setLastError(errorMessage(applied.error.code));
          return;
        }
        announceBookChanged(applied.value);
        await finalizeConnect();
      } finally {
        applyingRef.current = false;
        setApplying(false);
      }
    },

    cancelConnect: () => setStage(IDLE),

    disconnect: teardownConnection,

    syncNow: () => void engineRef.current?.syncNow(),

    // A user tap may open the Google popup, which the silent path cannot.
    reauth: async () => {
      if (!authRef.current) return;
      const token = await authRef.current.getToken(true);
      if (token.ok) await engineRef.current?.syncNow();
    },

    resolveUseLocal: () => void engineRef.current?.resolveUseLocal(),
    resolveUseRemote: () => void engineRef.current?.resolveUseRemote(),
  };

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
