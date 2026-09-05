import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { createMemorySyncStore } from "../../src/adapters/memory-sync-store";
import { decodeEnvelope, encodeEnvelope } from "../../src/adapters/sync-envelope";
import { createAccount, updateAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { bookFingerprint } from "../../src/kernel/merge";
import { err, type Result } from "../../src/kernel/result";
import type { Book } from "../../src/kernel/types";
import type { LedgerRepository } from "../../src/ports/ledger-repository";
import type { SyncStorePort } from "../../src/ports/sync-store";
import { createLedgerApp } from "../../src/service/ledger-app";
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

function engineFor(
  repo: LedgerRepository,
  store: SyncStorePort,
  runExclusive: <V>(fn: () => Promise<V>) => Promise<V> = serialLock(),
) {
  const states: SyncState[] = [];
  const changed: Book[] = [];
  const engine = createSyncEngine({
    repo,
    store,
    runExclusive,
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
    write: (payload, ifUnchanged) => inner.write(payload, ifUnchanged),
  };
}

/** Fires `onReload` once the cycle's *second* `load()` has already read the book — the
 * one seam the reload-and-recheck cannot see past. The check has just looked at the old
 * book; a save landing now is the one the cycle goes on to overwrite. */
function committingAfterReload(inner: LedgerRepository, onReload: () => void): LedgerRepository {
  let loads = 0;
  return {
    async load() {
      loads += 1;
      const result = await inner.load();
      if (loads === 2) onReload();
      return result;
    },
    save: (book) => inner.save(book),
  };
}

const hasAmount = (b: Book, amount: number) =>
  b.journal.some((e) => e.postings.some((p) => p.amount === amount));

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
      write: (payload, ifUnchanged) => plain.write(payload, ifUnchanged),
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
    // ...nor the repository: the two loads are the running cycle's snapshot and its
    // re-read before the upload. A second cycle would have made it four.
    expect(loadSpy).toHaveBeenCalledTimes(2);
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
        write: (payload, ifUnchanged) => plain.write(payload, ifUnchanged),
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

  it("uploads the commit that lands while the empty remote is being read", async () => {
    const { book, cashId, foodId } = makeBook();
    const inner = createMemorySyncStore(); // first device: Drive holds nothing yet
    const repo = createMemoryRepository(book);
    const midCycle = spend(book, cashId, foodId, 300, T(6));
    const store = committingDuringRead(inner, async () => {
      await repo.save(midCycle);
    });
    const { engine, changed } = engineFor(repo, store);

    await engine.syncNow();

    // The snapshot this branch used to upload was taken before the probe and read that
    // established the remote was empty.
    const uploaded = unwrap(decodeEnvelope(inner.getPayload()!));
    expect(uploaded.journal).toHaveLength(1);
    expect(hasAmount(uploaded, 300)).toBe(true);
    // Unlike the merge branch, nothing local was ever at risk: this branch never saves.
    expect(bookFingerprint(unwrap(await repo.load())!)).toBe(bookFingerprint(midCycle));
    expect(changed).toHaveLength(0);
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

  it("guards the upload with the rev it merged against", async () => {
    const { book, cashId, foodId } = makeBook();
    const remote = spend(book, cashId, foodId, 700, T(5));
    const store = createMemorySyncStore(encodeEnvelope(remote));
    const { engine } = harness(spend(book, cashId, foodId, 100, T(4)), store);
    const writeSpy = vi.spyOn(store, "write");
    await engine.syncNow();
    expect(writeSpy).toHaveBeenCalledWith(expect.any(String), "1"); // the rev it read
  });

  it("a refused upload re-runs the cycle instead of parking in offline", async () => {
    const { book, cashId, foodId } = makeBook();
    const remote = spend(book, cashId, foodId, 700, T(5));
    const store = createMemorySyncStore(encodeEnvelope(remote));
    const { repo, engine } = harness(spend(book, cashId, foodId, 100, T(4)), store);

    // Another device lands its own write in the moment between this cycle's read and its
    // upload: the guarded write is refused, and the payload it would have overwritten
    // survives — which is the whole point of the precondition.
    const original = store.write.bind(store);
    let displaced = false;
    vi.spyOn(store, "write").mockImplementation(async (payload, ifUnchanged) => {
      if (!displaced) {
        displaced = true;
        store.setPayload(encodeEnvelope(spend(remote, cashId, foodId, 900, T(7))));
      }
      return original(payload, ifUnchanged);
    });

    await engine.syncNow();

    // Not `offline`: the retry re-read, re-merged against the newer remote, and settled.
    expect(engine.getState().kind).toBe("idle");
    const settled = unwrap(await repo.load())!;
    expect(settled.journal).toHaveLength(3);
    for (const amount of [100, 700, 900]) expect(hasAmount(settled, amount)).toBe(true);
    expect(unwrap(decodeEnvelope(store.getPayload()!)).journal).toHaveLength(3);
  });

  it("a second refusal is reported, not retried forever", async () => {
    const { book, cashId, foodId } = makeBook();
    const remote = spend(book, cashId, foodId, 700, T(5));
    const store = createMemorySyncStore(encodeEnvelope(remote));
    const { engine } = harness(spend(book, cashId, foodId, 100, T(4)), store);
    let writes = 0;
    vi.spyOn(store, "write").mockImplementation(async () => {
      writes += 1;
      return err("SYNC_REMOTE_CHANGED", "always refused");
    });

    await engine.syncNow();

    // A store that refuses the *unconditional* retry too is not losing a race any more,
    // so the engine stops rather than spinning against it.
    expect(writes).toBe(2);
    const state = engine.getState();
    expect(state.kind).toBe("error");
    expect(state.kind === "error" && state.errorCode).toBe("SYNC_REMOTE_CHANGED");
  });

  // --- ...and a commit landing in the one window the reload-and-recheck cannot see —
  // between that check and the cycle's own save — is held off by the shared lock. ---

  it("a second tab's commit sharing the sync lock is not clobbered by the cycle", async () => {
    /** One cycle, with a second tab committing right after the cycle's reload-check.
     * `shareLock` decides whether that tab's `commit()` takes the engine's lock — false
     * reproduces the bare `repo.save(next)` this fix replaced. */
    async function race(shareLock: boolean) {
      const { book, cashId, foodId } = makeBook();
      const remote = spend(book, cashId, foodId, 700, T(5));
      const store = createMemorySyncStore(encodeEnvelope(remote));
      const inner = createMemoryRepository(book);
      const lock = serialLock();
      // The second tab writes through the plain repository: only the syncing tab reloads.
      const app = createLedgerApp(inner, {
        now: () => T(6),
        runExclusive: shareLock ? lock : undefined,
      });
      const commits: Promise<Result<Book>>[] = [];
      const repo = committingAfterReload(inner, () => {
        commits.push(
          app.addEntry(book, {
            date: "2026-01-10",
            description: "second tab",
            fromAccountId: cashId,
            lines: [{ toAccountId: foodId, amount: 300 }],
          }),
        );
      });
      const { engine } = engineFor(repo, store, lock);

      await engine.syncNow();
      expect((await Promise.all(commits)).every((outcome) => outcome.ok)).toBe(true);

      return { engine, store, repo: inner };
    }

    // Control: unlocked, the cycle's save lands on top of the second tab's and the 300
    // is gone from IndexedDB — and from Drive, so no device ever sees it again.
    const bare = await race(false);
    expect(hasAmount(unwrap(await bare.repo.load())!, 300)).toBe(false);
    expect(hasAmount(unwrap(decodeEnvelope(bare.store.getPayload()!)), 300)).toBe(false);

    // Shared lock: the commit queues behind the whole cycle instead of landing inside it,
    // so its entry survives. The remote's 700 is still in Drive (the cycle uploaded
    // nothing over it), so at this point nothing has been lost anywhere...
    const shared = await race(true);
    const afterRace = unwrap(await shared.repo.load())!;
    expect(hasAmount(afterRace, 300)).toBe(true);
    expect(hasAmount(unwrap(decodeEnvelope(shared.store.getPayload()!)), 700)).toBe(true);

    // ...and the next cycle carries both, which is what "both edits survive" means here.
    shared.engine.notifyLocalChange();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.runAllTimersAsync();
    const converged = unwrap(await shared.repo.load())!;
    expect(converged.journal).toHaveLength(2);
    expect(hasAmount(converged, 300)).toBe(true);
    expect(hasAmount(converged, 700)).toBe(true);
    expect(unwrap(decodeEnvelope(shared.store.getPayload()!)).journal).toHaveLength(2);
  });
});
