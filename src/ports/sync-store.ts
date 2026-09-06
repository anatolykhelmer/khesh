import type { Result } from "../kernel/result";

/** A remote slot holding one opaque payload with a monotonically changing revision.
 * probe/read return null while no payload exists. Implementations map their failures
 * to: SYNC_AUTH_REQUIRED, SYNC_FILE_MISSING, SYNC_FILE_AMBIGUOUS, SYNC_REMOTE_CHANGED,
 * SYNC_STORE_FAILED. */
export interface SyncStorePort {
  probe(): Promise<Result<{ rev: string } | null>>;
  read(): Promise<Result<{ payload: string; rev: string } | null>>;
  /**
   * `ifUnchanged` is the rev the payload was merged against: the write is refused with
   * SYNC_REMOTE_CHANGED if the slot has moved past it, so the caller re-merges instead of
   * overwriting a revision it never saw. Omit it to overwrite whatever is there — what
   * the explicit "use this device's book" actions mean.
   *
   * Support is best effort. A transport with no precondition of its own ignores the
   * argument and last-writer-wins, which is what this store did everywhere before.
   */
  write(payload: string, ifUnchanged?: string): Promise<Result<{ rev: string }>>;
}
