import { createContext, useContext } from "react";
import type {
  FirstConnectChoice,
  FirstConnectPlan,
  LocalState,
  RemoteInspection,
} from "../../service/sync-connect";
import type { SyncState } from "../../service/sync-engine";
import type { SyncActivity } from "./sync-session";

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
  /** What the local side held when `pendingPlan` was decided. Null whenever the plan is.
   *
   * Exposed rather than re-derived from `book`: the screen must judge what a choice
   * destroys against the same local state that produced the choices, and the staleness
   * gate already guarantees the two agree for as long as the plan is live. Re-deriving
   * would be a second source of truth that can only ever drift. */
  pendingLocalState: LocalState | null;
  /** A first-connect plan was dropped because the local book moved out from under it,
   * and the user has not tapped Connect since. Without this the choice screen simply
   * vanishes and Connect looks like it did nothing (BL-050). Never true at the same time
   * as `pendingPlan`: both are derived from one stage, which is either `choosing` or
   * `dropped` and cannot be both. */
  planWasDropped: boolean;
  /** The session's own record of what is currently running, so a screen can gate a
   * button on exactly the operation it means rather than on one shared `applying`. */
  activity: SyncActivity;
  connect: () => Promise<void>;
  /** Recovery for SYNC_FILE_MISSING: forget the dead file id and run `connect` again,
   * inspection and all, so a Drive that does hold a book still reaches the choice UI. */
  reconnect: () => Promise<void>;
  /** Apply one of `pendingPlan`'s choices. `onStarted` fires once the dispatch is
   * accepted — never for a tap the provider turns away, either because the live plan no
   * longer offers that choice or because another apply is already running. A screen that
   * marks the running choice must key on this rather than on the tap: the two guards are
   * invisible from outside, so a refused tap would otherwise re-label the wrong button
   * while a different choice runs. */
  applyChoice: (choice: FirstConnectChoice, onStarted?: () => void) => Promise<void>;
  /** Ends the first-connect flow *as the screen shows it*: no plan, no inspection, no
   * dropped-plan notice. The Cancel button, and `performReset` once the erase has landed —
   * an erase leaves nothing for either to be about. (`performReset` used to *need* it for
   * a dropped plan, which is invisible to an "is anything connected?" gate; that gate is
   * gone and its `disconnect()` is unconditional, so the call is now a second, portless
   * write of the same `IDLE`. See `ResetSyncDeps.cancelConnect`.)
   *
   * Not a cancellation, despite the name: it is one `setState`. A `connect()` already in
   * flight keeps running, and the store, auth and file id it bound to the user's real
   * Drive file stay bound — `disconnect` is what lets go of those. Do not reach for this
   * to make something else safe. */
  cancelConnect: () => void;
  disconnect: () => Promise<void>;
  /** Published to every screen through the sync snapshot for the whole of `performReset`.
   * Replaces the `DangerZone → SettingsScreen → SyncSection → ConnectDrive` prop chain,
   * whose middle hops were invisible to the suite: deleting both left 724/724 green. */
  beginErase: () => void;
  endErase: () => void;
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
