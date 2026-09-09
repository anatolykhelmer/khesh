import { createContext, useContext } from "react";
import type { FirstConnectChoice, FirstConnectPlan, RemoteInspection } from "../../service/sync-connect";
import type { SyncState } from "../../service/sync-engine";

export type SyncContextValue = {
  /** VITE_GOOGLE_CLIENT_ID is present: without it the whole feature stays hidden. */
  configured: boolean;
  connected: boolean;
  email: string | null;
  state: SyncState | null;
  /** Non-null means the first-connect choice UI is open. */
  pendingInspection: RemoteInspection | null;
  /** What to offer for the pending inspection, decided once when the remote was
   * inspected so the choices cannot shift under the user's finger. Null whenever
   * `pendingInspection` is.
   *
   * "Decided once" is enforced, not merely intended: the plan is stamped with the
   * `LocalState` it was derived from, and both fields read null the moment the book
   * moves away from it — see `pending-plan-rule.ts`. Deciding once and then rendering
   * against a book that has since changed is the same bug wearing the opposite hat. */
  pendingPlan: FirstConnectPlan | null;
  /** A connect or first-connect choice is running: its buttons stay disabled, so a
   * second tap cannot start a second load/merge/save/write over the first. */
  applying: boolean;
  connect: () => Promise<void>;
  /** Recovery for SYNC_FILE_MISSING: forget the dead file id and run `connect` again,
   * inspection and all, so a Drive that does hold a book still reaches the choice UI. */
  reconnect: () => Promise<void>;
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
