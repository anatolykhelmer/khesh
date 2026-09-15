import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import {
  createDriveSyncStore,
  createGoogleAuth,
  fetchAccountEmail,
} from "../../adapters/google-drive-sync";
import { createSyncMetaStore } from "../../adapters/sync-meta-store";
import { createSyncEngine } from "../../service/sync-engine";
import { useLedger } from "../ledger-context";
import { SyncContext, type SyncContextValue } from "./sync-context";
import { createSyncSession, type SyncSession } from "./sync-session";
import { runExclusive } from "./sync-lock";

const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? "";

export function SyncProvider({ children }: { children: ReactNode }) {
  const { book, repo, announceBookChanged } = useLedger();

  // `repo` through a getter, so the session is created once and never depends on this
  // value's identity.
  const repoRef = useRef(repo);
  repoRef.current = repo;

  // Lazy init through a ref and not `useMemo`: `useMemo` is a performance hint with no
  // identity guarantee and is double-invoked under StrictMode, and there is an engine
  // behind this allocation.
  const sessionRef = useRef<SyncSession | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = createSyncSession({
      clientId: CLIENT_ID,
      createAuth: () => createGoogleAuth(CLIENT_ID),
      createStore: createDriveSyncStore,
      createEngine: createSyncEngine,
      metaStore: createSyncMetaStore(),
      getRepo: () => repoRef.current,
      runExclusive,
      announceBookChanged,
      fetchAccountEmail: (getToken) => fetchAccountEmail(getToken),
    });
  }
  const session = sessionRef.current;

  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);

  useEffect(() => {
    session.setBook(book);
  }, [book, session]);

  // The session's page-level subscriptions — the local-commit signal, `visibilitychange`,
  // `online` — live for as long as this effect and not as long as the session. The session
  // is created once in the ref above and survives StrictMode's dev cycle of
  // setup → cleanup → setup, so wiring them at construction and removing them in
  // `dispose()` left them gone for good after the first dev remount.
  //
  // **Cleanup detaches and nothing else. There is deliberately no `dispose()` effect.**
  // The session lives in a ref *so that* it survives that cycle; a sibling effect cleanup
  // that released the connection and cleared the listeners undid exactly what the ref was
  // for, and did it incoherently — `dispose()` writes no connection state, so a remount
  // could render `connected: true` over `current === null`: no engine, so local commits go
  // to `current?.engine` and vanish, and a resume that had already latched never runs
  // again. The two halves were a contradiction, not a bug in either half.
  //
  // Disposing terminally instead — nulling the ref so a remount builds a fresh session —
  // does not close it: React does not re-render between StrictMode's cleanup and the second
  // setup, so that setup, and the `useSyncExternalStore` subscription beside it, would both
  // run against the session just disposed while the ref says to make a new one. The
  // incoherence would only move.
  //
  // What settles it is what `dispose()` *is*: it revokes the user's Google token. That is a
  // decision the user makes (Disconnect, the Settings erase), not a lifecycle event — an
  // unmount that signed them out of Drive would be wrong even if React only ever did it
  // once. So the session's lifetime is this tab's, and a genuine unmount of this provider
  // leaks the connection object: the page listeners come off here, the local-commit signal
  // with them, and the most an orphaned engine can still do is finish one already-scheduled
  // debounce cycle (`sync-engine.ts` has no other timer). The provider is at the root and
  // never unmounts, so in this app that path does not arise.
  useEffect(() => session.attach(), [session]);

  const value: SyncContextValue = useMemo(() => {
    const choosing = snap.stage.kind === "choosing" ? snap.stage : null;
    return {
      configured: snap.configured,
      connected: snap.connected,
      email: snap.email,
      state: snap.state,
      pendingInspection: choosing?.inspection ?? null,
      pendingPlan: choosing?.plan ?? null,
      pendingLocalState: choosing?.plannedFor ?? null,
      planWasDropped: snap.stage.kind === "dropped",
      activity: snap.activity,
      lastError: snap.lastError,
      connect: () => session.connect(),
      reconnect: () => session.reconnect(),
      applyChoice: (choice, onStarted) => session.applyChoice(choice, onStarted),
      cancelConnect: () => session.cancelConnect(),
      disconnect: () => session.disconnect(),
      beginErase: () => session.beginErase(),
      endErase: () => session.endErase(),
      syncNow: () => session.syncNow(),
      reauth: () => session.reauth(),
      resolveUseLocal: () => session.resolveUseLocal(),
      resolveUseRemote: () => session.resolveUseRemote(),
    };
  }, [snap, session]);

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
