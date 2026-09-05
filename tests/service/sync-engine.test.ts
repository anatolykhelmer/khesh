import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { createMemorySyncStore } from "../../src/adapters/memory-sync-store";
import { decodeEnvelope, encodeEnvelope } from "../../src/adapters/sync-envelope";
import { createAccount, updateAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { bookFingerprint } from "../../src/kernel/merge";
import type { Book } from "../../src/kernel/types";
import type { LedgerRepository } from "../../src/ports/ledger-repository";
import type { SyncStorePort } from "../../src/ports/sync-store";
import { createSyncEngine, type SyncState } from "../../src/service/sync-engine";
import { NOW, unwrap } from "../helpers";

const T = (n: number) => `2026-09-02T10:${String(n).padStart(2, "0")}:00.000Z`;

function serialLock() {
  let chain: Promise<unknown> = Promise.resolve();
  return <V>(fn: () => Promise<V>): Promise<V> => {
    const next = chain.then(fn);
    chain = next.catch(() => undefined);
    return next;
  };
}

function makeBook(): { book: Book; cashId: string; foodId: string } {
  let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
  book = unwrap(createAccount(book, { parentId: null, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false }, NOW));
  book = unwrap(createAccount(book, { parentId: null, name: "Food", type: "expense", currency: "ILS", isPlaceholder: false }, NOW));
  return { book, cashId: book.accounts[0].id, foodId: book.accounts[1].id };
}

function spend(book: Book, cashId: string, foodId: string, amount: number, at: string): Book {
  return unwrap(
    postEntry(book, {
      date: "2026-01-10",
      description: "x",
      postings: [
        { accountId: foodId, side: "debit", amount },
        { accountId: cashId, side: "credit", amount },
      ],
    }, at),
  );
}

function engineFor(repo: LedgerRepository, store: SyncStorePort) {
  const states: SyncState[] = [];
  const changed: Book[] = [];
  const engine = createSyncEngine({
    repo,
    store,
    runExclusive: serialLock(),
    onBookChanged: (b) => changed.push(b),
    onStateChanged: (s) => states.push(s),
    now: () => T(30),
    debounceMs: 3000,
  });
  return { engine, states, changed };
}

function harness(book: Book, store = createMemorySyncStore()) {
  const repo = createMemoryRepository(book);
  return { repo, store, ...engineFor(repo, store) };
}

/** Fires `onFirstRead` inside the cycle's download, i.e. after the cycle took its local
 * snapshot and before it persists anything — the window a real commit lands in while
 * the network round trips are in flight. */
function committingDuringRead(
  inner: SyncStorePort,
  onFirstRead: () => Promise<void>,
): SyncStorePort {
  let fired = false;
  return {
    probe: () => inner.probe(),
    async read() {
      const result = await inner.read();
      if (!fired) {
        fired = true;
        await onFirstRead();
      }
      return result;
    },
    write: (payload) => inner.write(payload),
  };
}

describe("sync engine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("first device: uploads the local book into an empty store", async () => {
    const { book } = makeBook();
    const { store, engine } = harness(book);
    await engine.syncNow();
    const remote = unwrap(decodeEnvelope(store.getPayload()!));
    expect(bookFingerprint(remote)).toBe(bookFingerprint(book));
    expect(engine.getState()).toEqual({ kind: "idle", lastSyncAt: T(30) });
  });

  it("two devices converge through the shared store", async () => {
    const { book, cashId, foodId } = makeBook();
    const store = createMemorySyncStore();
    const a = harness(spend(book, cashId, foodId, 100, T(1)), store);
    const b = harness(spend(book, cashId, foodId, 200, T(2)), store);
    await a.engine.syncNow();
    await b.engine.syncNow();
    await a.engine.syncNow();
    const bookA = unwrap(await a.repo.load())!;
    const bookB = unwrap(await b.repo.load())!;
    expect(bookFingerprint(bookA)).toBe(bookFingerprint(bookB));
    expect(bookA.journal).toHaveLength(2);
    expect(b.changed.length).toBeGreaterThan(0); // B adopted A's entry via onBookChanged
  });

  it("skips the download when rev is unchanged and nothing is dirty", async () => {
    const { book } = makeBook();
    const { store, engine } = harness(book);
    await engine.syncNow();
    const readSpy = vi.spyOn(store, "read");
    await engine.syncNow();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("debounces notifyLocalChange into one cycle", async () => {
    const { book } = makeBook();
    const { store, engine } = harness(book);
    await engine.syncNow();
    const writeSpy = vi.spyOn(store, "write");
    engine.notifyLocalChange();
    engine.notifyLocalChange();
    engine.notifyLocalChange();
    await vi.advanceTimersByTimeAsync(2999);
    expect(writeSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    // rev unchanged remotely and the local book is unchanged too -> no write, but the cycle ran
    expect(engine.getState().kind).toBe("idle");
  });

  it("a local change after upload is not swallowed by the probe skip", async () => {
    const { book, cashId, foodId } = makeBook();
    const { repo, store, engine } = harness(book);
    await engine.syncNow();
    await repo.save(spend(book, cashId, foodId, 300, T(3)));
    engine.notifyLocalChange();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.runAllTimersAsync();
    const remote = unwrap(decodeEnvelope(store.getPayload()!));
    expect(remote.journal).toHaveLength(1);
  });

  it("maps failures to needsAuth and offline, and recovers", async () => {
    const { book } = makeBook();
    const { store, engine } = harness(book);
    store.failNext("SYNC_AUTH_REQUIRED");
    await engine.syncNow();
    expect(engine.getState().kind).toBe("needsAuth");
    await engine.syncNow();
    expect(engine.getState().kind).toBe("idle");
    store.failNext("SYNC_STORE_FAILED");
    await engine.syncNow();
    expect(engine.getState().kind).toBe("offline");
  });

  it("rule 1: an unreadable remote enters manualResolution; resolveUseLocal overwrites it", async () => {
    const { book } = makeBook();
    const store = createMemorySyncStore("this is not an envelope");
    const { engine } = harness(book, store);
    await engine.syncNow();
    expect(engine.getState().kind).toBe("manualResolution");
    await engine.resolveUseLocal();
    expect(engine.getState().kind).toBe("idle");
    expect(bookFingerprint(unwrap(decodeEnvelope(store.getPayload()!)))).toBe(bookFingerprint(book));
  });

  it("rule 2: a future-format remote is an error, and nothing is uploaded over it", async () => {
    const { book } = makeBook();
    const payload = JSON.stringify({ app: "khesh", format: 99, encrypted: false, book: {} });
    const store = createMemorySyncStore(payload);
    const { engine } = harness(book, store);
    await engine.syncNow();
    const state = engine.getState();
    expect(state.kind).toBe("error");
    expect(state.kind === "error" && state.errorCode).toBe("SYNC_FORMAT_UNSUPPORTED");
    expect(store.getPayload()).toBe(payload);
  });

  it("resolveUseRemote adopts the remote book", async () => {
    const { book, cashId, foodId } = makeBook();
    const remoteBook = spend(book, cashId, foodId, 700, T(5));
    const store = createMemorySyncStore(encodeEnvelope(remoteBook));
    const { repo, engine, changed } = harness(book, store);
    await engine.resolveUseRemote();
    expect(bookFingerprint(unwrap(await repo.load())!)).toBe(bookFingerprint(remoteBook));
    expect(changed).toHaveLength(1);
  });

  it("dispose cancels the pending debounced cycle and blocks later triggers", async () => {
    const { book } = makeBook();
    const { store, engine } = harness(book);
    const probeSpy = vi.spyOn(store, "probe");
    engine.notifyLocalChange();
    engine.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.runAllTimersAsync();
    await engine.syncNow();
    expect(probeSpy).not.toHaveBeenCalled();
    expect(store.getPayload()).toBeNull();
  });

  it("a cycle queued behind a running one stops when dispose lands while it waits", async () => {
    // dispose() is called from the provider's disconnect(), which then clears the auth
    // the store's token accessor reads. A cycle that was already in the lock queue when
    // that happened must not go on to use the store — the outer disposed check ran
    // before the queue, so only a check inside the lock can stop it.
    const { book } = makeBook();
    const plain = createMemorySyncStore();
    let releaseFirstProbe: () => void = () => undefined;
    let announceFirstProbe: () => void = () => undefined;
    const firstProbeHeld = new Promise<void>((resolve) => {
      releaseFirstProbe = () => resolve();
    });
    const firstProbeEntered = new Promise<void>((resolve) => {
      announceFirstProbe = () => resolve();
    });
    let probes = 0;
    const store: SyncStorePort = {
      async probe() {
        probes += 1;
        if (probes === 1) {
          announceFirstProbe();
          await firstProbeHeld;
        }
        return plain.probe();
      },
      read: () => plain.read(),
      write: (payload) => plain.write(payload),
    };
    const repo = createMemoryRepository(book);
    const { engine, states } = engineFor(repo, store);
    const loadSpy = vi.spyOn(repo, "load");

    const running = engine.syncNow();
    await firstProbeEntered; // the first cycle really is inside the lock
    const queued = engine.syncNow(); // sits in the lock queue behind it
    engine.dispose();
    releaseFirstProbe();
    await running;
    await queued;

    expect(probes).toBe(1); // the queued cycle reached neither probe nor read
    expect(loadSpy).toHaveBeenCalledTimes(1); // ...nor the repository
    expect(states.filter((s) => s.kind === "syncing")).toHaveLength(1);
  });

  it("runExclusive serializes a debounced cycle that fires inside a running one", async () => {
    const { book } = makeBook();

    async function maxConcurrentCycles(
      lock: <V>(fn: () => Promise<V>) => Promise<V>,
    ): Promise<number> {
      const plain = createMemorySyncStore();
      let releaseFirstProbe: () => void = () => undefined;
      const firstProbeHeld = new Promise<void>((resolve) => {
        releaseFirstProbe = () => resolve();
      });
      let probes = 0;
      const store: SyncStorePort = {
        async probe() {
          probes += 1;
          if (probes === 1) await firstProbeHeld;
          return plain.probe();
        },
        read: () => plain.read(),
        write: (payload) => plain.write(payload),
      };
      let active = 0;
      let max = 0;
      const engine = createSyncEngine({
        repo: createMemoryRepository(book),
        store,
        runExclusive: (fn) =>
          lock(async () => {
            active += 1;
            max = Math.max(max, active);
            try {
              return await fn();
            } finally {
              active -= 1;
            }
          }),
        onBookChanged: () => undefined,
        onStateChanged: () => undefined,
        now: () => T(30),
        debounceMs: 3000,
      });
      engine.notifyLocalChange();
      const inFlight = engine.syncNow();
      // The debounce timer fires while the first cycle is parked inside probe().
      await vi.advanceTimersByTimeAsync(3000);
      const observed = max;
      releaseFirstProbe();
      await inFlight;
      engine.dispose();
      return observed;
    }

    // The unlocked run is the control: the two cycles really do overlap without a lock,
    // so the locked run's 1 is serialLock working rather than the timing failing to collide.
    expect(await maxConcurrentCycles((fn) => fn())).toBe(2);
    expect(await maxConcurrentCycles(serialLock())).toBe(1);
  });

  it("resolveUseLocal settles lastSeenRev: the next sync skips instead of redoing it", async () => {
    const { book } = makeBook();
    const store = createMemorySyncStore("this is not an envelope");
    const { engine } = harness(book, store);
    await engine.syncNow();
    await engine.resolveUseLocal();
    const readSpy = vi.spyOn(store, "read");
    const writeSpy = vi.spyOn(store, "write");
    await engine.syncNow();
    expect(readSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(engine.getState().kind).toBe("idle");
  });

  it("resolveUseRemote settles lastSeenRev: the next sync does not re-adopt", async () => {
    const { book, cashId, foodId } = makeBook();
    const remoteBook = spend(book, cashId, foodId, 700, T(5));
    const store = createMemorySyncStore(encodeEnvelope(remoteBook));
    const { engine, changed } = harness(book, store);
    await engine.resolveUseRemote();
    const readSpy = vi.spyOn(store, "read");
    await engine.syncNow();
    expect(readSpy).not.toHaveBeenCalled();
    expect(changed).toHaveLength(1);
    expect(engine.getState().kind).toBe("idle");
  });

  // --- A commit landing inside the cycle's network window is not the cycle's to lose:
  // the merge was computed from a snapshot taken before the round trips started. ---

  it("keeps a commit that lands mid-cycle, locally and on the remote", async () => {
    const { book, cashId, foodId } = makeBook();
    const remoteBook = spend(book, cashId, foodId, 700, T(5));
    const inner = createMemorySyncStore(encodeEnvelope(remoteBook));
    const repo = createMemoryRepository(book);
    const midCycle = spend(book, cashId, foodId, 300, T(6));
    const store = committingDuringRead(inner, async () => {
      await repo.save(midCycle);
    });
    const { engine, changed } = engineFor(repo, store);

    await engine.syncNow();

    const settled = unwrap(await repo.load())!;
    const amounts = (b: Book) => b.journal.flatMap((e) => e.postings.map((p) => p.amount)).sort();
    expect(settled.journal).toHaveLength(2);
    expect(amounts(settled)).toEqual([300, 300, 700, 700]);
    // The union reached Drive too, not just IndexedDB.
    expect(unwrap(decodeEnvelope(inner.getPayload()!)).journal).toHaveLength(2);
    // React state was handed the book that still has the mid-cycle entry.
    expect(changed).toHaveLength(1);
    expect(changed[0].journal).toHaveLength(2);
    expect(engine.getState().kind).toBe("idle");
  });

  it("costs no extra store call when nothing commits mid-cycle", async () => {
    const { book, cashId, foodId } = makeBook();
    const remoteBook = spend(book, cashId, foodId, 700, T(5));
    const store = createMemorySyncStore(encodeEnvelope(remoteBook));
    const { repo, engine, changed } = harness(spend(book, cashId, foodId, 100, T(4)), store);
    const probeSpy = vi.spyOn(store, "probe");
    const readSpy = vi.spyOn(store, "read");
    const writeSpy = vi.spyOn(store, "write");
    const saveSpy = vi.spyOn(repo, "save");

    await engine.syncNow();

    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledTimes(1); // the union differs from the remote
    expect(saveSpy).toHaveBeenCalledTimes(1); // ...and from the local book
    expect(changed).toHaveLength(1);
    expect(unwrap(await repo.load())!.journal).toHaveLength(2);
  });

  it("surfaces manualResolution when the mid-cycle commit conflicts with the remote", async () => {
    const { book, cashId, foodId } = makeBook();
    // Remote moved Food to USD — legal there, since no entry touches Food on either
    // side at the moment the cycle takes its snapshot, so the first merge succeeds.
    const remoteBook = unwrap(updateAccount(book, { id: foodId, currency: "USD" }, T(5)));
    const inner = createMemorySyncStore(encodeEnvelope(remoteBook));
    const repo = createMemoryRepository(book);
    // ...and then an ILS entry through Food lands mid-cycle, so the re-merge has to
    // refuse rather than reread 300 ILS as 300 USD.
    const midCycle = spend(book, cashId, foodId, 300, T(6));
    const store = committingDuringRead(inner, async () => {
      await repo.save(midCycle);
    });
    const { engine, changed } = engineFor(repo, store);

    await engine.syncNow();

    const state = engine.getState();
    expect(state.kind).toBe("manualResolution");
    expect(state.kind === "manualResolution" && state.errorCode).toBe("SYNC_MERGE_CONFLICT");
    expect(changed).toHaveLength(0);
    expect(bookFingerprint(unwrap(await repo.load())!)).toBe(bookFingerprint(midCycle));
    expect(inner.getPayload()).toBe(encodeEnvelope(remoteBook));
  });
});
