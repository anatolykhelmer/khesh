import type { Result } from "../kernel/result";

/** A remote slot holding one opaque payload with a monotonically changing revision.
 * probe/read return null while no payload exists. Implementations map their failures
 * to: SYNC_AUTH_REQUIRED, SYNC_FILE_MISSING, SYNC_STORE_FAILED. */
export interface SyncStorePort {
  probe(): Promise<Result<{ rev: string } | null>>;
  read(): Promise<Result<{ payload: string; rev: string } | null>>;
  write(payload: string): Promise<Result<{ rev: string }>>;
}
