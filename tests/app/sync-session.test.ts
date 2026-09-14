import { describe, expect, it } from "vitest";
import { createSyncSession, type ConnectionIO } from "../../src/app/sync/sync-session";
import {
  createFakeDrive,
  createGatedAuth,
  createGatedMetaStore,
  flush,
} from "../helpers/sync-harness";
import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { encodeEnvelope } from "../../src/adapters/sync-envelope";
import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import type { Book } from "../../src/kernel/types";
import { err, ok } from "../../src/kernel/result";
import { createSyncEngine } from "../../src/service/sync-engine";
import { NOW, unwrap } from "../helpers";

/** A book with no user data: `holdsNoUserData` answers true, so `LocalState` is "empty". */
function emptyBook(): Book {
  return unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
}

/** A book with one posted entry, so `LocalState` is "real" — the side of the matrix that
 * offers all three choices.
 *
 * Deviates from the brief: `postEntry`'s real signature takes `postings: PostingInput[]`
 * (`{ accountId, side, amount }`, at least two postings across two distinct accounts),
 * not the brief's `lines: [{ accountId, amount, currency }]` — that shape does not exist
 * on the kernel. Modelled on `tests/adapters/sync-envelope.test.ts`'s `fullBook()`. */
function realBook(): Book {
  let book = emptyBook();
  book = unwrap(createAccount(book,
    { parentId: null, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false }, NOW));
  book = unwrap(createAccount(book,
    { parentId: null, name: "Opening Balance", type: "equity", currency: "ILS", isPlaceholder: false }, NOW));
  const [cash, opening] = book.accounts;
  book = unwrap(postEntry(book,
    {
      date: "2026-09-01",
      description: "seed",
      postings: [
        { accountId: cash.id, side: "debit", amount: 1000 },
        { accountId: opening.id, side: "credit", amount: 1000 },
      ],
    }, NOW));
  return book;
}

/** What a Drive file holding `realBook()` contains. */
function remotePayload(): string {
  return encodeEnvelope(realBook());
}

function makeSession(overrides: Record<string, unknown> = {}) {
  const auth = createGatedAuth();
  const drive = createFakeDrive();
  const meta = createGatedMetaStore();
  const repo = createMemoryRepository();
  // Captured so a test can act as a write that grabbed the store before a teardown — the
  // only way to reach BL-053's window from outside.
  let capturedIo: ConnectionIO | null = null;
  const session = createSyncSession({
    clientId: "test-client",
    createAuth: () => auth,
    createStore: (io: ConnectionIO) => {
      capturedIo = io;
      return drive.storeFor(io);
    },
    createEngine: createSyncEngine,
    metaStore: meta,
    getRepo: () => repo,
    runExclusive: serialLock(),
    announceBookChanged: () => {},
    fetchAccountEmail: async () => ok("someone@example.com"),
    ...overrides,
  });
  return { session, auth, drive, meta, repo, io: () => capturedIo! };
}

/** The serialising stand-in for navigator.locks, as in the sync engine's own suite. */
function serialLock() {
  let chain: Promise<unknown> = Promise.resolve();
  return <V>(fn: () => Promise<V>): Promise<V> => {
    const next = chain.then(fn);
    chain = next.catch(() => undefined);
    return next;
  };
}

describe("sync session: snapshot", () => {
  it("starts idle, disconnected and unconfigured-aware", () => {
    const { session } = makeSession();
    const snap = session.getSnapshot();
    expect(snap.configured).toBe(true);
    expect(snap.connected).toBe(false);
    expect(snap.email).toBeNull();
    expect(snap.stage.kind).toBe("idle");
    expect(snap.lastError).toBeNull();
    expect(snap.activity).toEqual({
      connecting: false,
      applying: false,
      disconnecting: false,
      erasing: false,
      blocking: false,
    });
  });

  it("reports configured false when the client id is empty", () => {
    const { session } = makeSession({ clientId: "" });
    expect(session.getSnapshot().configured).toBe(false);
  });

  it("returns the same snapshot object while nothing changes", () => {
    const { session } = makeSession();
    expect(session.getSnapshot()).toBe(session.getSnapshot());
  });

  it("notifies subscribers and hands out a new object when a field moves", () => {
    const { session } = makeSession();
    const before = session.getSnapshot();
    let notified = 0;
    const unsubscribe = session.subscribe(() => {
      notified += 1;
    });
    session.beginErase();
    expect(notified).toBe(1);
    expect(session.getSnapshot()).not.toBe(before);
    expect(session.getSnapshot().activity.erasing).toBe(true);
    unsubscribe();
    session.endErase();
    expect(notified).toBe(1);
  });

  it("derives blocking from the other four rather than holding it", () => {
    const { session } = makeSession();
    session.beginErase();
    expect(session.getSnapshot().activity.blocking).toBe(true);
    session.endErase();
    expect(session.getSnapshot().activity.blocking).toBe(false);
  });
});
