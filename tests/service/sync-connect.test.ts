import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { createMemorySyncStore } from "../../src/adapters/memory-sync-store";
import { decodeEnvelope, encodeEnvelope } from "../../src/adapters/sync-envelope";
import { createAccount, updateAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { bookFingerprint } from "../../src/kernel/merge";
import type { Book } from "../../src/kernel/types";
import { applyFirstConnect, inspectRemote } from "../../src/service/sync-connect";
import { NOW, LATER, unwrap, unwrapErr } from "../helpers";

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
