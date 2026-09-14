import { ok, type Result } from "../../src/kernel/result";
import type { SyncStorePort } from "../../src/ports/sync-store";
import type { GoogleAuth } from "../../src/adapters/google-drive-sync";
import type { SyncMeta, SyncMetaStore } from "../../src/adapters/sync-meta-store";
import { EMPTY_SYNC_META } from "../../src/adapters/sync-meta-store";
import type { ConnectionIO } from "../../src/app/sync/sync-session";

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A port call whose timing the test owns. The port under test awaits `enter()`; the test
 * calls `settle()` to let exactly one pending call through. This is what turns a race into
 * an ordering of lines instead of a sleep.
 */
export class Gate<T> {
  private readonly queue: Deferred<T>[] = [];
  /** How many times the port was entered, including calls not yet settled. */
  calls = 0;
  private autoValue: T | undefined = undefined;
  private isAuto = false;

  /** Resolve every call immediately with `value` instead of queueing. The default for
   * ports a given test is not timing; `manual()` hands timing back. */
  automatic(value: T): this {
    this.autoValue = value;
    this.isAuto = true;
    return this;
  }

  manual(): this {
    this.isAuto = false;
    return this;
  }

  enter(): Promise<T> {
    this.calls += 1;
    if (this.isAuto) return Promise.resolve(this.autoValue as T);
    const d = deferred<T>();
    this.queue.push(d);
    return d.promise;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Let one pending call resolve, then drain the microtask queue so the caller runs on. */
  async settle(value: T): Promise<void> {
    const d = this.queue.shift();
    if (!d) throw new Error("Gate.settle() with no pending call");
    d.resolve(value);
    await flush();
  }

  async fail(error: unknown): Promise<void> {
    const d = this.queue.shift();
    if (!d) throw new Error("Gate.fail() with no pending call");
    d.reject(error);
    await flush();
  }
}

/** Run every already-queued microtask. Several awaits can stand between a settle and the
 * state it produces, so one `await Promise.resolve()` is not enough. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/**
 * A remote that models **file identity**, which `createMemorySyncStore` does not: it is a
 * single slot with no notion of a file, so "no second file was created" cannot be asserted
 * against it. BL-053 is exactly that assertion, so the fake keeps a map and only mints a
 * new id when `io.getFileId()` answers null.
 */
export type FakeDrive = {
  files: Map<string, string>;
  nextId: number;
  storeFor: (io: ConnectionIO) => SyncStorePort;
};

export function createFakeDrive(seed?: { id: string; payload: string }): FakeDrive {
  const files = new Map<string, string>();
  if (seed) files.set(seed.id, seed.payload);
  const drive: FakeDrive = {
    files,
    nextId: 1,
    storeFor(io: ConnectionIO): SyncStorePort {
      /**
       * The cached id, else a name search, else null: mirrors `resolveFileId` in
       * `google-drive-sync.ts` ("the cached one, else a search by name … else null"),
       * which is what lets a connection with no id of its own — a fresh connect, or a
       * second device — find a book a test seeded straight into `drive.files` instead of
       * through a prior `write()`. This fake models one Drive holding at most one khesh
       * book, so "search by name" is "the one entry already there"; a real ambiguous
       * match is the adapter's own concern, untouched by this plan.
       */
      const discoverId = async (): Promise<string | null> => {
        const known = io.getFileId();
        if (known !== null) return known;
        if (files.size !== 1) return null;
        const [onlyId] = files.keys();
        await io.onFileId(onlyId);
        return onlyId;
      };
      const resolveId = async (): Promise<string> => {
        const discovered = await discoverId();
        if (discovered !== null) return discovered;
        // No id, and nothing to discover: this is the create-a-new-file path — the one
        // BL-053's duplicate came down. Recorded here so a test can count files rather
        // than infer.
        const id = `file-${drive.nextId}`;
        drive.nextId += 1;
        files.set(id, "");
        await io.onFileId(id);
        return id;
      };
      return {
        async probe() {
          const token = await io.getToken(false);
          if (!token.ok) return token;
          const id = await discoverId();
          const payload = id === null ? undefined : files.get(id);
          return ok(payload === undefined || payload === "" ? null : { rev: "1" });
        },
        async read() {
          const token = await io.getToken(false);
          if (!token.ok) return token;
          const id = await discoverId();
          const payload = id === null ? undefined : files.get(id);
          return ok(payload === undefined || payload === "" ? null : { payload, rev: "1" });
        },
        async write(payload: string) {
          const token = await io.getToken(false);
          if (!token.ok) return token;
          const id = await resolveId();
          files.set(id, payload);
          return ok({ rev: "1" });
        },
      };
    },
  };
  return drive;
}

/** An in-memory `SyncMetaStore` with a gate on `save`, so a test can stand inside the
 * window `finalizeConnect` writes in. */
export function createGatedMetaStore(initial: Partial<SyncMeta> = {}): SyncMetaStore & {
  record: SyncMeta;
  saveGate: Gate<void>;
} {
  const record: SyncMeta = { ...EMPTY_SYNC_META, ...initial };
  // Automatic by default: most tests do not care when a meta write lands. The ones that
  // stand inside that window call `meta.saveGate.manual()` first.
  const saveGate = new Gate<void>().automatic(undefined);
  return {
    record,
    saveGate,
    async load() {
      return { ...record };
    },
    async save(patch: Partial<SyncMeta>) {
      await saveGate.enter();
      Object.assign(record, patch);
    },
  };
}

/**
 * A `GoogleAuth` whose token fetches and revoke the test times.
 *
 * Only `interactive: true` goes to the gate. `createGoogleAuth` (`google-drive-sync.ts`)
 * is explicit that this is an "in-memory hourly token": once a fetch has landed, every
 * silent call — a store's per-operation `getToken(false)`, a `syncNow()` cycle's own reads
 * and writes — returns it for free, no network round trip. A fake that queued those too
 * would make every connect a multi-settle affair no test actually wants to spell out, and
 * would hang a first-connect test that only ever drives the one popup. `interactive: true`
 * bypasses the cache unconditionally, because that is the one fetch a test *does* want to
 * see and time — `reauth()`'s included, even with a cached token still good, since it is
 * the deliberate user tap a stale token needs.
 *
 * `revoke()` does not clear the cache. Production does (`token = null`), but nothing here
 * needs that half modelled, and a released connection's io is still expected to answer a
 * trailing `getToken(false)` — a write already in flight when a teardown lets go — without
 * the test having to settle a gate call for a connection nothing is driving any more.
 */
export function createGatedAuth(): GoogleAuth & {
  tokenGate: Gate<Result<string>>;
  revokes: number;
} {
  const tokenGate = new Gate<Result<string>>();
  let cachedToken: string | null = null;
  const auth = {
    tokenGate,
    revokes: 0,
    async getToken(interactive: boolean) {
      if (!interactive && cachedToken !== null) return ok(cachedToken);
      const result = await tokenGate.enter();
      if (result.ok) cachedToken = result.value;
      return result;
    },
    async revoke() {
      auth.revokes += 1;
    },
  };
  return auth;
}
