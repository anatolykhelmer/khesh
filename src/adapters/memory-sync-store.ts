import { err, ok, type Result } from "../kernel/result";
import type { SyncStorePort } from "../ports/sync-store";

export type MemorySyncStore = SyncStorePort & {
  setPayload(payload: string): void;
  getPayload(): string | null;
  getRev(): string | null;
  failNext(code: "SYNC_AUTH_REQUIRED" | "SYNC_FILE_MISSING" | "SYNC_STORE_FAILED"): void;
};

export function createMemorySyncStore(initial?: string): MemorySyncStore {
  let payload: string | null = initial ?? null;
  let counter = initial === undefined ? 0 : 1;
  let pendingFailure: "SYNC_AUTH_REQUIRED" | "SYNC_FILE_MISSING" | "SYNC_STORE_FAILED" | null = null;

  function takeFailure<T>(): Result<T> | null {
    if (pendingFailure === null) return null;
    const code = pendingFailure;
    pendingFailure = null;
    return err(code, `injected ${code}`);
  }

  return {
    async probe() {
      const failure = takeFailure<{ rev: string } | null>();
      if (failure) return failure;
      return ok(payload === null ? null : { rev: String(counter) });
    },
    async read() {
      const failure = takeFailure<{ payload: string; rev: string } | null>();
      if (failure) return failure;
      return ok(payload === null ? null : { payload, rev: String(counter) });
    },
    async write(next: string) {
      const failure = takeFailure<{ rev: string }>();
      if (failure) return failure;
      payload = next;
      counter += 1;
      return ok({ rev: String(counter) });
    },
    setPayload(next: string) {
      payload = next;
      counter += 1;
    },
    getPayload: () => payload,
    getRev: () => (payload === null ? null : String(counter)),
    failNext(code) {
      pendingFailure = code;
    },
  };
}
