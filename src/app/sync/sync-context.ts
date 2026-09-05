import { createContext, useContext } from "react";
import type { FirstConnectChoice, RemoteInspection } from "../../service/sync-connect";
import type { SyncState } from "../../service/sync-engine";

export type SyncContextValue = {
  /** VITE_GOOGLE_CLIENT_ID is present: without it the whole feature stays hidden. */
  configured: boolean;
  connected: boolean;
  email: string | null;
  state: SyncState | null;
  /** Non-null means the first-connect choice UI is open. */
  pendingInspection: RemoteInspection | null;
  connect: () => Promise<void>;
  applyChoice: (choice: FirstConnectChoice) => Promise<void>;
  cancelConnect: () => void;
  disconnect: () => Promise<void>;
  syncNow: () => void;
  reauth: () => Promise<void>;
  resolveUseLocal: () => void;
  resolveUseRemote: () => void;
  lastError: string | null;
};

export const SyncContext = createContext<SyncContextValue | null>(null);

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error("useSync requires SyncProvider");
  return ctx;
}
