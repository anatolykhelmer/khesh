import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createDriveSyncStore,
  createGoogleAuth,
  fetchAccountEmail,
  type GoogleAuth,
} from "../../adapters/google-drive-sync";
import { createSyncMetaStore } from "../../adapters/sync-meta-store";
import { errorMessage } from "../../service/error-messages";
import {
  applyFirstConnect,
  inspectRemote,
  type FirstConnectChoice,
  type RemoteInspection,
} from "../../service/sync-connect";
import { createSyncEngine, type SyncEngine, type SyncState } from "../../service/sync-engine";
import type { SyncStorePort } from "../../ports/sync-store";
import { useLedger } from "../ledger-context";
import { SyncContext, type SyncContextValue } from "./sync-context";
import { syncSignal } from "./sync-signal";

const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? "";

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request("khesh-sync", fn) as Promise<T>;
  }
  return fn();
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const { book, repo, announceBookChanged } = useLedger();
  const metaStore = useMemo(() => createSyncMetaStore(), []);
  const authRef = useRef<GoogleAuth | null>(null);
  const storeRef = useRef<SyncStorePort | null>(null);
  const engineRef = useRef<SyncEngine | null>(null);
  const fileIdRef = useRef<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [state, setState] = useState<SyncState | null>(null);
  const [pendingInspection, setPendingInspection] = useState<RemoteInspection | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const buildStore = useCallback((): SyncStorePort => {
    if (!authRef.current) authRef.current = createGoogleAuth(CLIENT_ID);
    if (!storeRef.current) {
      storeRef.current = createDriveSyncStore({
        getToken: (interactive = false) => authRef.current!.getToken(interactive),
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
    setPendingInspection(null);
    void startEngine().syncNow();
  }, [metaStore, startEngine]);

  const value: SyncContextValue = {
    configured: CLIENT_ID !== "",
    connected,
    email,
    state,
    pendingInspection,
    lastError,

    connect: async () => {
      setLastError(null);
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
      if (inspection.value.kind === "empty") {
        const applied = await applyFirstConnect("replaceRemote", { repo, store });
        if (!applied.ok) {
          setLastError(errorMessage(applied.error.code));
          return;
        }
        await finalizeConnect();
        return;
      }
      setPendingInspection(inspection.value); // "book" and "unreadable" both need the user
    },

    applyChoice: async (choice: FirstConnectChoice) => {
      setLastError(null);
      const applied = await applyFirstConnect(choice, { repo, store: buildStore() });
      if (!applied.ok) {
        setLastError(errorMessage(applied.error.code));
        return;
      }
      announceBookChanged(applied.value);
      await finalizeConnect();
    },

    cancelConnect: () => setPendingInspection(null),

    disconnect: async () => {
      engineRef.current?.dispose();
      engineRef.current = null;
      storeRef.current = null;
      fileIdRef.current = null;
      await authRef.current?.revoke();
      authRef.current = null;
      await metaStore.save({ connected: false, fileId: null, accountEmail: null, lastSyncAt: null });
      setConnected(false);
      setEmail(null);
      setState(null);
      setPendingInspection(null);
    },

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
