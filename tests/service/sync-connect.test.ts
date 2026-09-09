import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { createMemorySyncStore } from "../../src/adapters/memory-sync-store";
import { decodeEnvelope, encodeEnvelope } from "../../src/adapters/sync-envelope";
import { createAccount, updateAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { bookFingerprint } from "../../src/kernel/merge";
import type { Book } from "../../src/kernel/types";
import type { SyncStorePort } from "../../src/ports/sync-store";
import { applyFirstConnect, inspectRemote } from "../../src/service/sync-connect";
import { NOW, LATER, unwrap, unwrapErr } from "../helpers";

/** The serialising stand-in for navigator.locks, as in the sync engine's suite. */
function serialLock() {
  let chain: Promise<unknown> = Promise.resolve();
  return <V>(fn: () => Promise<V>): Promise<V> => {
    const next = chain.then(fn);
    chain = next.catch(() => undefined);
    return next;
  };
}

function makeBook(name: string, at: string): Book {
  let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, at));
  book = unwrap(createAccount(book, { parentId: null, name, type: "asset", currency: "ILS", isPlaceholder: false }, at));
  return book;
}

describe("inspectRemote", () => {
  it("classifies empty, book, and unreadable remotes", async () => {
    expect(unwrap(await inspectRemote(createMemorySyncStore()))).toEqual({ kind: "empty" });

    const withBook = createMemorySyncStore(encodeEnvelope(makeBook("Cash", NOW)));
    expect(unwrap(await inspectRemote(withBook))).toEqual({ kind: "book", name: "Home", entryCount: 0 });

    const garbage = createMemorySyncStore("junk");
    expect(unwrap(await inspectRemote(garbage))).toEqual({ kind: "unreadable", errorCode: "SYNC_ENVELOPE_INVALID" });

    const future = createMemorySyncStore(JSON.stringify({ app: "khesh", format: 9, encrypted: false, book: {} }));
    expect(unwrap(await inspectRemote(future))).toEqual({ kind: "unreadable", errorCode: "SYNC_FORMAT_UNSUPPORTED" });
  });

  it("propagates a transport failure from read() as an error, not an inspection result", async () => {
    const store = createMemorySyncStore();
    store.failNext("SYNC_AUTH_REQUIRED");
    expect(unwrapErr(await inspectRemote(store)).code).toBe("SYNC_AUTH_REQUIRED");
  });
});

describe("applyFirstConnect", () => {
  it("uploads local when the remote is empty, for any choice", async () => {
    const local = makeBook("Cash", NOW);
    const repo = createMemoryRepository(local);
    const store = createMemorySyncStore();
    const book = unwrap(await applyFirstConnect("useRemote", { repo, store }));
    expect(bookFingerprint(book)).toBe(bookFingerprint(local));
    expect(bookFingerprint(unwrap(decodeEnvelope(store.getPayload()!)))).toBe(bookFingerprint(local));
  });

  it("useRemote adopts the Drive book locally", async () => {
    const local = makeBook("Cash", NOW);
    const remote = makeBook("Wallet", LATER);
    const repo = createMemoryRepository(local);
    const store = createMemorySyncStore(encodeEnvelope(remote));
    const book = unwrap(await applyFirstConnect("useRemote", { repo, store }));
    expect(bookFingerprint(book)).toBe(bookFingerprint(remote));
    expect(bookFingerprint(unwrap(await repo.load())!)).toBe(bookFingerprint(remote));
    expect(store.getPayload()).toBe(encodeEnvelope(remote)); // remote untouched
  });

  it("replaceRemote overwrites Drive with the local book", async () => {
    const local = makeBook("Cash", NOW);
    const remote = makeBook("Wallet", LATER);
    const repo = createMemoryRepository(local);
    const store = createMemorySyncStore(encodeEnvelope(remote));
    unwrap(await applyFirstConnect("replaceRemote", { repo, store }));
    expect(bookFingerprint(unwrap(decodeEnvelope(store.getPayload()!)))).toBe(bookFingerprint(local));
    expect(bookFingerprint(unwrap(await repo.load())!)).toBe(bookFingerprint(local));
  });

  it("merge unions both sides and writes the union to both places", async () => {
    const local = makeBook("Cash", NOW);
    const remote = makeBook("Wallet", LATER);
    const repo = createMemoryRepository(local);
    const store = createMemorySyncStore(encodeEnvelope(remote));
    const book = unwrap(await applyFirstConnect("merge", { repo, store }));
    const names = book.accounts.map((a) => a.name).sort();
    expect(names).toEqual(["Cash", "Wallet"]);
    expect(bookFingerprint(unwrap(await repo.load())!)).toBe(bookFingerprint(book));
    expect(bookFingerprint(unwrap(decodeEnvelope(store.getPayload()!)))).toBe(bookFingerprint(book));
  });

  it("useRemote propagates a read failure without touching local or remote state", async () => {
    const local = makeBook("Cash", NOW);
    const remote = makeBook("Wallet", LATER);
    const repo = createMemoryRepository(local);
    const store = createMemorySyncStore(encodeEnvelope(remote));
    store.failNext("SYNC_STORE_FAILED");
    const result = await applyFirstConnect("useRemote", { repo, store });
    expect(unwrapErr(result).code).toBe("SYNC_STORE_FAILED");
    expect(bookFingerprint(unwrap(await repo.load())!)).toBe(bookFingerprint(local));
    expect(store.getPayload()).toBe(encodeEnvelope(remote));
  });

  it("merge propagates a read failure the same way", async () => {
    const local = makeBook("Cash", NOW);
    const remote = makeBook("Wallet", LATER);
    const repo = createMemoryRepository(local);
    const store = createMemorySyncStore(encodeEnvelope(remote));
    store.failNext("SYNC_AUTH_REQUIRED");
    const result = await applyFirstConnect("merge", { repo, store });
    expect(unwrapErr(result).code).toBe("SYNC_AUTH_REQUIRED");
    expect(bookFingerprint(unwrap(await repo.load())!)).toBe(bookFingerprint(local));
    expect(store.getPayload()).toBe(encodeEnvelope(remote));
  });

  it("merge keeps a commit that lands while it is reading the remote", async () => {
    // The same load-network-save window the sync engine's cycle has, one-shot and much
    // narrower here — but another tab can still commit into the shared repository while
    // this one waits on Drive, and the save must not roll that back.
    const local = makeBook("Cash", NOW);
    const remote = makeBook("Wallet", LATER);
    const repo = createMemoryRepository(local);
    const inner = createMemorySyncStore(encodeEnvelope(remote));
    const midFlow = unwrap(
      createAccount(local, { parentId: null, name: "Savings", type: "asset", currency: "ILS", isPlaceholder: false }, LATER),
    );
    let committed = false;
    const store: SyncStorePort = {
      probe: () => inner.probe(),
      async read() {
        const result = await inner.read();
        if (!committed) {
          committed = true;
          await repo.save(midFlow);
        }
        return result;
      },
      write: (payload, ifUnchanged) => inner.write(payload, ifUnchanged),
    };

    const book = unwrap(await applyFirstConnect("merge", { repo, store }));

    expect(book.accounts.map((a) => a.name).sort()).toEqual(["Cash", "Savings", "Wallet"]);
    expect(bookFingerprint(unwrap(await repo.load())!)).toBe(bookFingerprint(book));
    expect(bookFingerprint(unwrap(decodeEnvelope(inner.getPayload()!)))).toBe(bookFingerprint(book));
  });

  // --- The merge choice on books that actually conflict. Every case above unions two
  // books that agree; these are the two shapes mergeBooks refuses outright, and the
  // first-connect flow has to hand the refusal back untouched rather than half-apply it.

  /** Cash + Food, then a fork: one device posts 100 ILS through Food while the other,
   * which has no postings on it, moves Food to USD. The union would silently reread
   * that 100 as USD, so mergeBooks refuses. */
  function currencyConflict(): { local: Book; remote: Book } {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    book = unwrap(createAccount(book, { parentId: null, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false }, NOW));
    book = unwrap(createAccount(book, { parentId: null, name: "Food", type: "expense", currency: "ILS", isPlaceholder: false }, NOW));
    const [cash, food] = book.accounts;
    const local = unwrap(
      postEntry(book, {
        date: "2026-01-10",
        description: "x",
        postings: [
          { accountId: food.id, side: "debit", amount: 100 },
          { accountId: cash.id, side: "credit", amount: 100 },
        ],
      }, LATER),
    );
    const remote = unwrap(updateAccount(book, { id: food.id, currency: "USD" }, LATER));
    return { local, remote };
  }

  /** A group that one device turned into a postable leaf and posted to, while the other
   * gave it a child: an account with both children and postings, which no rung repairs. */
  function childrenAndPostingsConflict(): { local: Book; remote: Book } {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    book = unwrap(createAccount(book, { parentId: null, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false }, NOW));
    book = unwrap(createAccount(book, { parentId: null, name: "Groups", type: "expense", currency: "ILS", isPlaceholder: true }, NOW));
    const [cash, group] = book.accounts;
    const flat = unwrap(updateAccount(book, { id: group.id, isPlaceholder: false }, LATER));
    const local = unwrap(
      postEntry(flat, {
        date: "2026-01-10",
        description: "x",
        postings: [
          { accountId: group.id, side: "debit", amount: 100 },
          { accountId: cash.id, side: "credit", amount: 100 },
        ],
      }, LATER),
    );
    const remote = unwrap(
      createAccount(book, { parentId: group.id, name: "Cafes", type: "expense", currency: "ILS", isPlaceholder: false }, LATER),
    );
    return { local, remote };
  }

  it.each([
    ["a currency reinterpretation", currencyConflict],
    ["an account with both children and postings", childrenAndPostingsConflict],
  ])("merge propagates the SYNC_MERGE_CONFLICT from %s, saving and uploading nothing", async (_label, build) => {
    const { local, remote } = build();
    const repo = createMemoryRepository(local);
    const store = createMemorySyncStore(encodeEnvelope(remote));
    const saveSpy = vi.spyOn(repo, "save");
    const writeSpy = vi.spyOn(store, "write");

    const result = await applyFirstConnect("merge", { repo, store });

    expect(unwrapErr(result).code).toBe("SYNC_MERGE_CONFLICT");
    expect(saveSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(bookFingerprint(unwrap(await repo.load())!)).toBe(bookFingerprint(local));
    expect(store.getPayload()).toBe(encodeEnvelope(remote));
  });

  it("runs two concurrent first connects one at a time under the sync lock", async () => {
    /**
     * Two applyFirstConnect calls started together — a double-tapped choice button, or
     * two tabs both mid-connect. Each runs its own load, download, merge, save and
     * upload; nothing in the sequence coordinates with anything, so uncoordinated they
     * interleave and each writes over what the other computed. Counted at `read`, which
     * sits inside the body: overlapping reads mean overlapping sequences.
     *
     * `lock` is the same helper the sync engine and every commit are handed.
     */
    async function overlap(lock?: <V>(fn: () => Promise<V>) => Promise<V>): Promise<number> {
      const local = makeBook("Cash", NOW);
      const repo = createMemoryRepository(local);
      const inner = createMemorySyncStore(encodeEnvelope(makeBook("Wallet", LATER)));
      let active = 0;
      let max = 0;
      const store: SyncStorePort = {
        probe: () => inner.probe(),
        async read() {
          active += 1;
          max = Math.max(max, active);
          await Promise.resolve(); // a round trip the other call can slip into
          const result = await inner.read();
          active -= 1;
          return result;
        },
        write: (payload, ifUnchanged) => inner.write(payload, ifUnchanged),
      };

      const results = await Promise.all([
        applyFirstConnect("merge", { repo, store, runExclusive: lock }),
        applyFirstConnect("merge", { repo, store, runExclusive: lock }),
      ]);

      expect(results.every((r) => r.ok)).toBe(true);
      const uploaded = unwrap(decodeEnvelope(inner.getPayload()!));
      expect(uploaded.accounts.map((a) => a.name).sort()).toEqual(["Cash", "Wallet"]);
      return max;
    }

    // The unlocked run is the control: the two sequences really do overlap without a
    // lock, so the locked run's 1 is the lock working rather than the timing failing to
    // collide.
    expect(await overlap()).toBe(2);
    expect(await overlap(serialLock())).toBe(1);
  });

  it("replaceRemote propagates a write failure instead of reporting success", async () => {
    const local = makeBook("Cash", NOW);
    const remote = makeBook("Wallet", LATER);
    const repo = createMemoryRepository(local);
    const store = createMemorySyncStore(encodeEnvelope(remote));
    store.failNext("SYNC_FILE_MISSING");
    const result = await applyFirstConnect("replaceRemote", { repo, store });
    expect(unwrapErr(result).code).toBe("SYNC_FILE_MISSING");
    expect(store.getPayload()).toBe(encodeEnvelope(remote)); // write never landed
  });
});

describe("applyFirstConnect with no local book", () => {
  it("useRemote adopts the Drive book into empty storage", async () => {
    const remote = makeBook("Wallet", LATER);
    const repo = createMemoryRepository(null);
    const store = createMemorySyncStore(encodeEnvelope(remote));
    const book = unwrap(await applyFirstConnect("useRemote", { repo, store }));
    expect(bookFingerprint(book)).toBe(bookFingerprint(remote));
    expect(bookFingerprint(unwrap(await repo.load())!)).toBe(bookFingerprint(remote));
    expect(store.getPayload()).toBe(encodeEnvelope(remote)); // remote untouched
  });

  it("useRemote still reports a read failure rather than inventing a book", async () => {
    const repo = createMemoryRepository(null);
    const store = createMemorySyncStore(encodeEnvelope(makeBook("Wallet", LATER)));
    store.failNext("SYNC_AUTH_REQUIRED");
    expect(unwrapErr(await applyFirstConnect("useRemote", { repo, store })).code).toBe(
      "SYNC_AUTH_REQUIRED",
    );
    expect(unwrap(await repo.load())).toBeNull();
  });

  it("useRemote against an empty remote still needs a local book", async () => {
    const repo = createMemoryRepository(null);
    const store = createMemorySyncStore();
    expect(unwrapErr(await applyFirstConnect("useRemote", { repo, store })).code).toBe("BOOK_INVALID");
  });

  // The narrowness of the relaxation is the point: these two upload the local book, so
  // they cannot run without one, and the UI never offers them in this state (Task 2).
  it("replaceRemote still refuses without a local book", async () => {
    const repo = createMemoryRepository(null);
    const store = createMemorySyncStore(encodeEnvelope(makeBook("Wallet", LATER)));
    expect(unwrapErr(await applyFirstConnect("replaceRemote", { repo, store })).code).toBe(
      "BOOK_INVALID",
    );
  });

  it("merge still refuses without a local book", async () => {
    const repo = createMemoryRepository(null);
    const store = createMemorySyncStore(encodeEnvelope(makeBook("Wallet", LATER)));
    expect(unwrapErr(await applyFirstConnect("merge", { repo, store })).code).toBe("BOOK_INVALID");
  });

  it("useRemote against an empty remote performs exactly one read", async () => {
    const local = makeBook("Cash", NOW);
    const repo = createMemoryRepository(local);
    const inner = createMemorySyncStore();
    let readCount = 0;
    const store: SyncStorePort = {
      probe: () => inner.probe(),
      async read() {
        readCount += 1;
        return inner.read();
      },
      write: (payload, ifUnchanged) => inner.write(payload, ifUnchanged),
    };

    const book = unwrap(await applyFirstConnect("useRemote", { repo, store }));
    expect(readCount).toBe(1);
    expect(bookFingerprint(book)).toBe(bookFingerprint(local));
  });

  it("useRemote against an undecodable remote returns an error and preserves the corrupt payload", async () => {
    const local = makeBook("Cash", NOW);
    const repo = createMemoryRepository(local);
    const store = createMemorySyncStore("junk");
    const result = await applyFirstConnect("useRemote", { repo, store });
    expect(unwrapErr(result).code).toBe("SYNC_ENVELOPE_INVALID");
    expect(store.getPayload()).toBe("junk"); // corrupt remote untouched
  });
});
