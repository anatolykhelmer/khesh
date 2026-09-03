import { decodeEnvelope, encodeEnvelope } from "../adapters/sync-envelope";
import type { LedgerErrorCode } from "../kernel/errors";
import { bookFingerprint, mergeBooks } from "../kernel/merge";
import { err, ok, type Result } from "../kernel/result";
import type { Book } from "../kernel/types";
import { validateBook } from "../kernel/validate";
import type { LedgerRepository } from "../ports/ledger-repository";
import type { SyncStorePort } from "../ports/sync-store";

export type SyncState =
  | { kind: "idle"; lastSyncAt: string | null }
  | { kind: "syncing"; lastSyncAt: string | null }
  | { kind: "offline"; lastSyncAt: string | null }
  | { kind: "needsAuth"; lastSyncAt: string | null }
  | { kind: "manualResolution"; lastSyncAt: string | null; errorCode: LedgerErrorCode }
  | { kind: "error"; lastSyncAt: string | null; errorCode: LedgerErrorCode };

export type SyncEngineDeps = {
  repo: LedgerRepository;
  store: SyncStorePort;
  runExclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  onBookChanged: (book: Book) => void;
  onStateChanged: (state: SyncState) => void;
  now?: () => string;
  debounceMs?: number;
};

export interface SyncEngine {
  syncNow(): Promise<void>;
  notifyLocalChange(): void;
  resolveUseLocal(): Promise<void>;
  resolveUseRemote(): Promise<void>;
  getState(): SyncState;
  dispose(): void;
}

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const debounceMs = deps.debounceMs ?? 3000;
  const nowIso = deps.now ?? (() => new Date().toISOString());

  let state: SyncState = { kind: "idle", lastSyncAt: null };
  let lastSeenRev: string | null = null;
  // Bumped by every local edit, recorded by every cycle that finished. A cycle skips
  // the download only when the remote rev is the one it last saw *and* no edit arrived
  // since the generation it is settling — an edit made while the cycle was in flight
  // leaves changeGen > syncedGen, so the next cycle downloads and uploads instead of
  // reading the unchanged rev as "nothing to do" and stranding that edit locally.
  let changeGen = 0;
  let syncedGen = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const setState = (next: SyncState) => {
    state = next;
    deps.onStateChanged(next);
  };

  const fail = (code: LedgerErrorCode) => {
    const lastSyncAt = state.lastSyncAt;
    if (code === "SYNC_AUTH_REQUIRED") setState({ kind: "needsAuth", lastSyncAt });
    else if (code === "SYNC_STORE_FAILED") setState({ kind: "offline", lastSyncAt });
    else if (code === "SYNC_ENVELOPE_INVALID" || code === "SYNC_MERGE_CONFLICT")
      setState({ kind: "manualResolution", lastSyncAt, errorCode: code });
    else setState({ kind: "error", lastSyncAt, errorCode: code });
  };

  const succeed = (rev: string | null, gen: number) => {
    lastSeenRev = rev;
    syncedGen = gen;
    setState({ kind: "idle", lastSyncAt: nowIso() });
  };

  async function cycle(gen: number): Promise<Result<string | null>> {
    const loaded = await deps.repo.load();
    if (!loaded.ok) return loaded;
    const local = loaded.value;
    if (local === null) return err("BOOK_INVALID", "No local book to sync");

    const probed = await deps.store.probe();
    if (!probed.ok) return probed;
    if (probed.value !== null && probed.value.rev === lastSeenRev && gen === syncedGen) {
      return ok(lastSeenRev);
    }

    const readResult = await deps.store.read();
    if (!readResult.ok) return readResult;

    if (readResult.value === null) {
      const written = await deps.store.write(encodeEnvelope(local));
      if (!written.ok) return written;
      return ok(written.value.rev);
    }

    const remote = decodeEnvelope(readResult.value.payload);
    if (!remote.ok) return remote;

    const merged = mergeBooks(local, remote.value);
    if (!merged.ok) return merged;
    // mergeBooks does not validate its own output. An ok merge that still fails here is
    // a kernel bug, not a user conflict: abort with the validation code, keep the local
    // book, and upload nothing.
    const valid = validateBook(merged.value);
    if (!valid.ok) return valid;

    let rev: string | null = readResult.value.rev;
    if (bookFingerprint(merged.value) !== bookFingerprint(local)) {
      const saved = await deps.repo.save(merged.value);
      if (!saved.ok) return saved;
      deps.onBookChanged(merged.value);
    }
    if (bookFingerprint(merged.value) !== bookFingerprint(remote.value)) {
      const written = await deps.store.write(encodeEnvelope(merged.value));
      if (!written.ok) return written;
      rev = written.value.rev;
    }
    return ok(rev);
  }

  async function syncNow(): Promise<void> {
    if (disposed) return;
    await deps.runExclusive(async () => {
      const gen = changeGen;
      setState({ kind: "syncing", lastSyncAt: state.lastSyncAt });
      const outcome = await cycle(gen);
      if (outcome.ok) succeed(outcome.value, gen);
      else fail(outcome.error.code);
    });
  }

  return {
    syncNow,

    notifyLocalChange() {
      if (disposed) return;
      changeGen += 1;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void syncNow();
      }, debounceMs);
    },

    async resolveUseLocal() {
      if (disposed) return;
      await deps.runExclusive(async () => {
        const gen = changeGen;
        const loaded = await deps.repo.load();
        if (!loaded.ok || loaded.value === null) {
          fail(loaded.ok ? "BOOK_INVALID" : loaded.error.code);
          return;
        }
        const written = await deps.store.write(encodeEnvelope(loaded.value));
        if (!written.ok) {
          fail(written.error.code);
          return;
        }
        succeed(written.value.rev, gen);
      });
    },

    async resolveUseRemote() {
      if (disposed) return;
      await deps.runExclusive(async () => {
        const gen = changeGen;
        const readResult = await deps.store.read();
        if (!readResult.ok) {
          fail(readResult.error.code);
          return;
        }
        if (readResult.value === null) {
          fail("SYNC_FILE_MISSING");
          return;
        }
        const remote = decodeEnvelope(readResult.value.payload);
        if (!remote.ok) {
          fail(remote.error.code);
          return;
        }
        const saved = await deps.repo.save(remote.value);
        if (!saved.ok) {
          fail(saved.error.code);
          return;
        }
        deps.onBookChanged(remote.value);
        succeed(readResult.value.rev, gen);
      });
    },

    getState: () => state,

    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}
