import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { createMemorySyncStore } from "../../src/adapters/memory-sync-store";
import { decodeEnvelope, encodeEnvelope } from "../../src/adapters/sync-envelope";
import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { bookFingerprint } from "../../src/kernel/merge";
import type { Book } from "../../src/kernel/types";
import { applyFirstConnect, inspectRemote } from "../../src/service/sync-connect";
import { NOW, LATER, unwrap } from "../helpers";

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
});
