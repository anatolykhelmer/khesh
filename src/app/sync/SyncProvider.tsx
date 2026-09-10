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
  connectStillApplies,
  IDLE,
  teardownVerdict,
  visibleError,
  type ConnectStage,
  type TeardownIntent,
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
  // Bumped by `teardownConnection` before it touches anything, so an async operation that
  // started against the old connection can tell that the store, the auth and the file id
  // it captured have since been pulled out from under it. A ref, not state: it has to be
  // readable synchronously from inside a callback that is mid-await, and nothing renders
  // from it. Deliberately invisible to `pending-plan-rule`'s tables — those describe the
  // stage, and this is a fact about the provider's timeline that no stage can express.
  const teardownGenerationRef = useRef(0);
  // The other direction, and the other half of the same problem: connections this tab has
  // established. `teardownConnection`'s tail reads it back to find out whether it still
  // speaks for the current connection at all. Both counters exist because a teardown and
  // a connect can be in flight at once — the notice this branch adds asks the user to
  // tap Connect at precisely the moment a teardown is running.
  const connectionGenerationRef = useRef(0);
  // Teardowns the *user* asked for: Disconnect, the Settings reset, start over. A third
  // counter and not a flag, because the question a connect asks is "did an erase begin
  // under me?", which outlives the teardown itself — `performReset` goes on to erase the
  // book after `disconnect()` has resolved, and a flag cleared at the tail would answer no
  // for the rest of that flow. A subset of `teardownGenerationRef` on purpose: a
  // `bookVanished` teardown must never veto a connect, because the drop notice asks for
  // that connect. See `connectStillApplies`, which is the only reader.
  const userTeardownsRef = useRef(0);

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
      // Being connected retires any first-connect state by definition — the plan
      // describes a connection that is now made, and the notice asks for a tap on a
      // Connect row this tab is about to stop rendering (`SyncSection` swaps to the
      // connected view). Left standing, neither is reachable and neither can be cleared:
      // the notice would reappear on the Connect row the user's next Disconnect opens,
      // explaining a book move from arbitrarily earlier in the session.
      setStage(IDLE);
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

  /** Claim the connection: persist it, show it, and start the engine. `userTeardownsAtStart`
   * is `userTeardownsRef` as it stood when the *operation* began — at the top of `connect()`
   * or `applyChoice`, not here, because the erase can begin during the Drive round trips in
   * between and this function is only ever reached after them. */
  const finalizeConnect = useCallback(async (userTeardownsAtStart: number) => {
    // Asked before the bump, so an operation the user's own erase has already overtaken
    // does not first claim a connection the tail would then have to override.
    if (!connectStillApplies(userTeardownsAtStart, userTeardownsRef.current)) return;
    // Bumped before the first await, so a teardown tail landing anywhere from here on
    // sees that a connection has superseded it — including one that lands between the
    // meta write below and `setConnected(true)`.
    connectionGenerationRef.current += 1;
    const emailResult = await fetchAccountEmail(async (interactive = false) => {
      // Same reasoning as `buildStore`'s `getToken`, and now the same shape. A teardown
      // that began while the apply was in flight nulls this ref before its first await,
      // so `authRef.current!` would throw a TypeError inside an async function nobody
      // awaits — `applyChoice` is invoked as `void sync.applyChoice(…)`. A failed email
      // is already a case this function handles: it becomes `null`.
      const auth = authRef.current;
      if (!auth) return err<string>("SYNC_AUTH_REQUIRED", "Sync is not connected");
      return auth.getToken(interactive);
    });
    const accountEmail = emailResult.ok ? emailResult.value : null;
    // And again, because the email fetch above is a network round trip and an erase can
    // begin inside it. Everything below this line is what a teardown would have to undo:
    // the persisted record, the connected view, and an engine armed at the user's real
    // Drive file. The residual is the `metaStore.save` await itself — a teardown that
    // begins inside it still reaches `setConnected(true)` and `startEngine()`, and is
    // caught on the other side by the tail's `override` (see `teardownVerdict`) only when
    // that tail has not already run.
    if (!connectStillApplies(userTeardownsAtStart, userTeardownsRef.current)) return;
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

  /** Let go of everything this tab holds against the user's Drive file: the engine, the
   * store, the auth and the cached file id. **Releasing, and nothing else** — it writes no
   * connection state, tells no screen anything and takes no view on *why*. That split is
   * what lets `teardownConnection` run it twice.
   *
   * Everything dangerous goes synchronously, ahead of both awaits: a disposed engine is
   * the difference between "this tab may still write the old book to Drive" and "it may
   * not", and the two awaits after it are unbounded (`revoke()` is a network round trip
   * with no timeout of its own).
   *
   * Idempotent and null-safe on every ref, so running it against an already-released tab
   * costs one best-effort write to the meta database — which is what `performStartOver`
   * relies on when it disconnects unconditionally. */
  const releaseConnection = useCallback(async () => {
    engineRef.current?.dispose();
    engineRef.current = null;
    storeRef.current = null;
    // The auth comes off the ref **here**, synchronously beside the store, and the revoke
    // below runs against the local. Nulling it after the await instead was the bug the PR
    // review caught: `revoke()` clears its own token cache on entry but the object stays
    // on the ref, so a `connect()` inside the window — which is what the drop notice asks
    // the user for — reuses it, caches a fresh interactive token into it, and then this
    // throws that auth away. The user is left holding a live, correct choice screen whose
    // next tap builds an empty auth, does a silent `getToken(false)`, and paints
    // SYNC_AUTH_REQUIRED under the choices with no notice to explain it. Off the ref
    // first, and `connect()` builds its own auth that nothing here can reach.
    const auth = authRef.current;
    authRef.current = null;
    await forgetFile();
    // `auth`, not `authRef.current` — see nine lines up before changing this. Reading the
    // ref here would revoke whatever auth is on it *now*, which after an intervening
    // `connect()` is the user's new one.
    await auth?.revoke();
  }, [forgetFile]);

  /** Say that this tab is disconnected: persist it to the shared sync-meta record, and
   * bring this tab's own view into line. The other half of a teardown, and deliberately
   * the half that touches no ref — by the time this runs the connection is already gone;
   * what is left is bookkeeping about it.
   *
   * Safe to run concurrently in several tabs: each tab only ever released its own refs and
   * its own token, and every tab's write here agrees, so whichever lands last still leaves
   * the shared record correct. */
  const recordDisconnection = useCallback(async (intent: TeardownIntent) => {
    await metaStore.save({ connected: false, accountEmail: null, lastSyncAt: null });
    setConnected(false);
    setEmail(null);
    setState(null);
    // Not an unconditional clear, and not a plain value either: this runs after the
    // teardown's awaits, so the stage it must decide from is whatever is current when it
    // lands — while the plan it is entitled to drop is the one named in `intent`, captured
    // when the teardown started. See `afterTeardown`.
    setStage((s) => afterTeardown(s, intent));
    // `userAction` only. The flow the user ended can have left an error on screen that
    // belongs to a screen they are leaving — a failed `applyChoice` on the recovery screen
    // before Start over, a failed file-missing Reconnect before Disconnect — and
    // `afterTeardown` has just written `IDLE`, which `visibleError` does not suppress, so
    // it would otherwise be painted under the Connect button of the fresh screen this
    // teardown opens. Not on the `bookVanished` arm: there the same clear swallowed the
    // sign-in error of a Connect the user made *during* the teardown window, which is the
    // "Connect looks like it did nothing" this branch exists to remove.
    //
    // The reason written here before was false and is worth naming: it said the erase
    // flows have no window to swallow from because `performReset` "ends by calling
    // `cancelConnect()` itself", as though that cancelled an in-flight connect. It does
    // not — `cancelConnect` is `setStage(IDLE)` and nothing more.
    //
    // What makes this arm safe is not that no error can arrive but that clearing is the
    // right answer for any error that does. `bookVanished` leaves the user where they are
    // and asks them to tap Connect, so an error from that tap is the only thing they have
    // to go on. `userAction` is the user leaving: Disconnect collapses the row, reset and
    // start over open onboarding. Every error still standing belongs to the screen being
    // left — including a sign-in failure from a connect begun inside the window, which is
    // about a Connect button that is disabled for the length of the flow and about to stop
    // existing. It does not need the path survey the old comment rested on.
    if (intent.cause === "userAction") setLastError(null);
  }, [metaStore]);

  /** Tear down this tab's connection: release everything it holds against Drive, then
   * record the disconnection. Shared by `disconnect` (the user's own Settings action) and
   * by the effect below (another tab reset the book while this tab was still connected).
   *
   * Two functions with a verdict between them, rather than one body with a guard on every
   * line. A connect can *complete* inside this function's own window — after a vanished
   * book the drop notice asks the user for exactly that — so by the time the release has
   * finished, "what this teardown is entitled to do next" is a real question with three
   * answers, and `teardownVerdict` is where it is answered and tested.
   *
   * The reverse overlap is **not** covered, and this is the honest statement of the limit:
   * a `finalizeConnect` already past its own last guard when this starts has already
   * bumped, so the tail sees a changed count but that finalize can still land on top of
   * whatever this writes — `connected: true` and `setStage(IDLE)`, notice included.
   * Narrowed by `finalizeConnect`'s second `connectStillApplies` check but not closed, and
   * recorded as a known debt rather than papered over here: telling "a finalize that will
   * succeed" from one that will not is not something a counter read at one instant can do.
   *
   * `intent` reaches `afterTeardown` and the error clear: a first-connect plan on screen
   * means one thing when the book was pulled out from under it and another when the user
   * ended the flow — and on the first of those, *which* plan matters too. */
  const teardownConnection = useCallback(
    async (intent: TeardownIntent) => {
      // Both bumps go before the first await, so anything already in flight sees them the
      // moment this begins rather than two awaits later.
      teardownGenerationRef.current += 1;
      if (intent.cause === "userAction") userTeardownsRef.current += 1;
      const connections = connectionGenerationRef.current;
      await releaseConnection();
      const verdict = teardownVerdict(intent, connections, connectionGenerationRef.current);
      // Asked before the meta write rather than after, so that a superseded teardown never
      // submits a contradicting write at all. That is the whole claim: it is *not* an
      // ordering guarantee. `createSyncMetaStore().save` is a non-atomic read-modify-write
      // (`await db.get`, then `await db.put` of a merge), so two concurrent saves each
      // merge from their own snapshot and the loser's patch is dropped whole — submission
      // order does not decide the outcome. A `finalizeConnect` that bumps inside the
      // synchronous gap between this and the write below is therefore still unordered
      // against it.
      if (verdict === "superseded") return;
      // A connect finalized inside the window above and this teardown outranks it, so the
      // refs released at the top are live again — a fresh engine pointed at the user's real
      // Drive file, and a fresh store and auth behind it. Recording "disconnected" without
      // this is the exact end state BL-040 names: an app and a persisted record that say
      // disconnected, over an engine still syncing. The release runs *before* the record so
      // the engine is gone from the first synchronous line, rather than for two more awaits
      // after the app has already claimed to be disconnected.
      if (verdict === "override") await releaseConnection();
      await recordDisconnection(intent);
    },
    [releaseConnection, recordDisconnection],
  );

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
  // Drive file, and the transition is exactly the moment to let go of them. Reading
  // `choosing`/`liveStage` here is the mutation that breaks it: that view is already null
  // on the very render the plan goes stale, so `shouldTearDown` would see no pending
  // inspection, and with `connected` still false nothing would ever release the refs.
  //
  // Its position relative to the effect that commits the drop, on the other hand, is not
  // load-bearing and swapping the two changes nothing: both are created by the same
  // render and close over that render's `stage`, and a pending passive effect always runs
  // with the values of the render that queued it. Nor does the notice depend on the two
  // firing in any particular order — this teardown settles the stage itself through
  // `afterTeardown`, which is the whole point of passing an intent.
  //
  // That same raw `stage` is what the intent carries, and it must come from here rather
  // than from a closure inside `teardownConnection` or a ref mirroring the state: it is
  // this render's stage, the one `shouldTearDown` just judged, so the plan the teardown
  // announces as dropped is exactly the plan it was called about. Threading it as an
  // argument also keeps `teardownConnection` off `stage` as a dependency — it is this
  // effect's own dependency, so a new identity per stage change would re-run the effect.
  useEffect(() => {
    const previous = previousBookRef.current;
    previousBookRef.current = book;
    const pendingInspection = stage.kind === "choosing" ? stage.inspection : null;
    if (!shouldTearDown(previous, book, { connected, pendingInspection })) return;
    void teardownConnection({ cause: "bookVanished", startedFrom: stage }).catch(() => {
      // `teardownConnection`'s first act is `releaseConnection()`, whose
      // `engineRef.current?.dispose()` runs synchronously ahead of every await in either
      // function — the one danger this effect exists to close (a live engine
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
  //
  // The third argument must be `applying` and nothing else. It marks the one window in
  // which the local state moves *because of the user's own choice*: pass `false` and a
  // successful `useRemote` announces "the book changed, connect again" over its own
  // success for the length of `finalizeConnect`'s account-email request; pass anything
  // broader — a screen's `disabled`, an import in flight, `state.kind !== "idle"` — and
  // the drop stays suppressed while the book really is moving underneath, which is the
  // hole `plannedFor` exists to close. Both are booleans, so nothing here catches it.
  const liveStage = afterLocalStateChange(stage, localState, applying);
  useEffect(() => {
    // The notice and a red error may not share the collapsed Connect row. `components.css`
    // reserves colour for what needs a person or cannot be undone, and a dropped plan needs
    // one tap on Connect — the neutral sentence is the whole explanation. The error that
    // would sit under it is a failed apply from the plan being dropped, which is now moot.
    // Not folded into `afterLocalStateChange`: that table is pure and `lastError` is not
    // part of `ConnectStage`.
    //
    // Above the early return, not below it, and keyed on the stage rather than on the
    // transition. A `DROPPED` written by `teardownConnection`'s own `setStage` arrives here
    // as `stage`, and `afterLocalStateChange` returns its input for anything that is not
    // `choosing` — so `liveStage === stage` and the return below would skip the clear on
    // exactly the path where the teardown carries none of its own. Keyed this way the rule
    // is "while the plan is dropped there is no error in state", which is the guarantee
    // `visibleError`'s doc comment claims. Idempotent: React bails out on an unchanged
    // null, and this effect only re-runs when the stage moves.
    //
    // This is the *state* half and cannot be the whole rule: it lands a render after the
    // notice becomes derivable, so `visibleError` in the context value covers the frame in
    // between. `teardownConnection` carries a clear too, but only on its `userAction` arm —
    // an unconditional one there swallowed the sign-in error of a Connect the user made
    // during the teardown window.
    if (liveStage.kind === "dropped") setLastError(null);
    if (liveStage === stage) return;
    // Compare-and-set rather than `setStage(liveStage)`. This effect is passive, so a tap
    // handled between the paint and this flush has already queued a stage of its own —
    // `connect()` queues `IDLE` — and a plain write would land on top of it, leaving the
    // notice showing beside the `lastError` of the connect it asked for. Committing only
    // while the stage is still the one this render derived from leaves a newer write
    // alone; the render it schedules re-derives the gate from it anyway.
    setStage((s) => (s === stage ? liveStage : s));
  }, [liveStage, stage]);
  const choosing = liveStage.kind === "choosing" ? liveStage : null;

  const connect = async () => {
    if (applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    // Which erase generation this connect belongs to, read before the first await:
    // everything below is a Drive round trip, and the user's own erase can begin under any
    // of them. See `connectStillApplies`. `reconnect` awaits `forgetFile()` ahead of this,
    // so an erase beginning inside that one IndexedDB write is not seen here — that tap is
    // disabled while a teardown runs (`SyncSection`), and the teardown's own `override`
    // catches the finalize on the other side.
    const userTeardowns = userTeardownsRef.current;
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
      // The user's own erase began while Drive was being read, so nothing below is worth
      // doing and one line of it is actively harmful: `applyFirstConnect` *writes the local
      // book*, and both erase flows continue past the teardown — `performReset` calls
      // `resetAll()` next. An apply landing on either side of that either has its work
      // erased or, worse, restores the Drive book onto disk after the erase cleared it,
      // leaving the app on onboarding with the old book back in storage. The sync lock
      // orders the two but does not stop that; `DangerZone`'s own comment says so.
      //
      // Silent, like `applyChoice`'s doomed-apply arm and for the same reason: the user
      // asked for the thing that made this moot, and every screen this can happen on is
      // one they are leaving — onboarding replaces Settings after a reset, and a Disconnect
      // taken during a hung Reconnect collapses the row it was on. (That Disconnect is the
      // one path that reaches here without the tap having been disabled: it is deliberately
      // not gated on `sync.applying`, because a reconnect that will not finish is exactly
      // when disconnecting must stay possible.) The `finally` still clears `applying`, so
      // no button is left reading "Connecting…".
      if (!connectStillApplies(userTeardowns, userTeardownsRef.current)) return;
      const plan = firstConnectOptions(localState, inspection.value);
      if (plan.kind === "apply") {
        const applied = await applyFirstConnect(plan.choice, { repo, store, runExclusive });
        if (!applied.ok) {
          setLastError(errorMessage(applied.error.code));
          return;
        }
        await finalizeConnect(userTeardowns);
        return;
      }
      // "choose" and "explain" both need the user to see the screen. `localState` here is
      // the value captured before the await above; stamping the plan with it is what lets
      // the gate above notice the book moving out from under these choices — during the
      // Drive read, and, far more often, at any point while they sit on screen.
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

    // The render half of the same rule as the clear in the drop-commit effect, and not an
    // alternative to it — `visibleError` closes the frame between the derived notice and
    // that state write, the clear stops a hidden error resurfacing later. Both halves,
    // and why each is insufficient alone, are written up there.
    lastError: visibleError(liveStage, lastError),

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

    applyChoice: async (choice: FirstConnectChoice, onStarted?: () => void) => {
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
      // Past both guards, so this choice and no other is what is now running. Announced
      // here rather than assumed by the caller: a tap the guards turn away leaves the
      // screen's "Working…" on the refused button while the accepted one runs underneath
      // it — and, if that one fails, puts its error under the wrong label. Before the
      // first await, so it batches with `setApplying(true)` and no frame sees one
      // without the other.
      onStarted?.();
      // Which connection this apply is running on. Read before the first await, and
      // compared in the failure arm below.
      const generation = teardownGenerationRef.current;
      // And which erase generation, for the guards this shares with `connect()`. A
      // separate counter because the two questions differ: the one above asks "was I torn
      // down?" and any cause answers it, this one asks "did the user start erasing under
      // me?" and only `userAction` does.
      const userTeardowns = userTeardownsRef.current;
      try {
        setLastError(null);
        // Same guard `connect()` puts in front of its auto-apply, and for the same reason:
        // `applyFirstConnect` writes the local book, and an erase that has begun will
        // either throw that work away or have it land after `resetAll()` and put the Drive
        // book back on disk. No screen can produce this today — `DangerZone` gates the
        // reset tap on `sync.applying` and on a plan being on screen, so an erase cannot
        // begin between the tap and here — but that is a fact about another component, and
        // this branch has twice had to retract a claim resting on one.
        if (!connectStillApplies(userTeardowns, userTeardownsRef.current)) return;
        const applied = await applyFirstConnect(choice, {
          repo,
          store: buildStore(),
          runExclusive,
        });
        if (!applied.ok) {
          // A doomed apply says nothing. When the book vanishes mid-apply the teardown
          // fires on that flush and this apply cannot survive it: `buildStore`'s
          // `getToken` answers SYNC_AUTH_REQUIRED the moment `authRef` is nulled, so the
          // red line under the choices would read "Sync is not connected" — an artifact
          // of the teardown, needing nobody, contradicting the neutral drop notice that
          // `afterTeardown` is writing for this very event.
          //
          // No claim here about which lands first, because it varies and the likelier
          // order is the opposite of what this comment used to assert. The apply holds
          // the store it captured before the teardown, and that store's `getToken` reads
          // `authRef.current` live — so the apply keeps working until the teardown nulls
          // that ref, then fails at its next token fetch, usually well before the tail.
          // But an apply sitting between token fetches survives longer and can fail after
          // the tail, and only then does clearing `lastError` at the drop commit fail to
          // cover it. The guard holds for both orders because the bump above precedes
          // every await in the teardown.
          //
          // A generation counter and not the stage: this is a fact about the provider's
          // timeline, invisible to `pending-plan-rule`'s tables and to the whole test
          // suite with it. Scoped to this arm deliberately — `connect()`'s failure arm
          // recreates the auth and the store it needs, so a concurrent teardown does not
          // doom it, and silencing it there would hide real sign-in failures.
          if (teardownGenerationRef.current !== generation) return;
          setLastError(errorMessage(applied.error.code));
          return;
        }
        announceBookChanged(applied.value);
        await finalizeConnect(userTeardowns);
      } finally {
        applyingRef.current = false;
        setApplying(false);
      }
    },

    cancelConnect: () => setStage(IDLE),

    // Wrapped, not passed through: `teardownConnection` now takes an intent, and a bare
    // reference would let an `onClick={sync.disconnect}` hand it a click event.
    disconnect: () => teardownConnection({ cause: "userAction" }),

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
