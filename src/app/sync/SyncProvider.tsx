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

  useEffect(() => () => session.dispose(), [session]);

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
