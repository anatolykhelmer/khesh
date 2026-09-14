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

/**
 * A session already past first connect: an empty local book against an empty Drive is the
 * one combination `firstConnectOptions` answers with `{kind: "apply", choice:
 * "replaceRemote"}`, so it reaches `connected` with no choice screen in the way.
 *
 * Deviates from the brief: also seeds `repo`, not just `session.setBook()`. `setBook`
 * (Task 5) never writes the repository — it only mirrors the book for the session's own
 * `localState()` — so in production the two stay in step because the app's own ledger
 * code is what persists there. This harness has no such code, and `replaceRemote` reads
 * the book to upload from `repo.load()` (`applyFirstConnect` → `loadLocal`), not from
 * `setBook`'s argument. Without this, `repo.load()` answers null, the apply fails with
 * BOOK_INVALID, and the session never reaches `connected: true`.
 */
async function connectedSession() {
  const h = makeSession();
  const book = emptyBook();
  await h.repo.save(book);
  h.session.setBook(book);
  const connecting = h.session.connect();
  await h.auth.tokenGate.settle(ok("token-1"));
  await connecting;
  expect(h.session.getSnapshot().connected).toBe(true);
  return h;
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

describe("sync session: connection identity", () => {
  it("puts the choices on screen when Drive holds a book and local holds one too", async () => {
    const { session, auth, drive } = makeSession();
    drive.files.set("file-remote", JSON.stringify({ schema: "khesh.book.v1" }));
    session.setBook(realBook());
    const connecting = session.connect();
    expect(session.getSnapshot().activity.connecting).toBe(true);
    expect(session.getSnapshot().activity.blocking).toBe(true);
    await auth.tokenGate.settle(ok("token-1"));
    await connecting;
    expect(session.getSnapshot().stage.kind).toBe("choosing");
    expect(session.getSnapshot().activity.connecting).toBe(false);
  });

  it("disposes the engine and revokes the token when the user disconnects", async () => {
    const { session, auth, meta } = await connectedSession();
    await session.disconnect();
    expect(auth.revokes).toBe(1);
    expect(meta.record.connected).toBe(false);
    expect(session.getSnapshot().connected).toBe(false);
  });

  it("completes a disconnect while a token fetch is still hanging", async () => {
    const { session, auth } = await connectedSession();
    const hung = session.reauth();           // never settled below
    await session.disconnect();               // must not wait on it
    expect(session.getSnapshot().connected).toBe(false);
    expect(auth.tokenGate.pending).toBe(1);
    void hung;
  });

  it("leaves a released connection its own file id, so a doomed write cannot duplicate", async () => {
    // BL-053. The old provider nulled a *shared* fileIdRef, so a write already in flight
    // read null, took the create-a-new-file path, and succeeded against a token not yet
    // revoked. Abandoning the connection instead of emptying it makes that unreachable.
    const { session, drive, io } = await connectedSession();
    const before = drive.files.size;
    await session.disconnect();
    expect(io().getFileId()).not.toBeNull();
    await io().getToken(false);               // whatever the doomed write does next
    expect(drive.files.size).toBe(before);
  });

  it("a connect superseded before its token settles writes no stage", async () => {
    // Deviates from the brief in two ways, both found by mutation-testing this test
    // itself: temporarily gutting `superseded`/`userEnds` left it green, which means the
    // brief's version (settle, *then* disconnect, then assert "idle") was not exercising
    // supersession at all.
    //
    // First, the ordering: the brief settled the token before disconnecting and named
    // this "mid-inspect". As literally written that superseded nothing — the caching
    // `createGatedAuth` needs so every other test in this file does not hang on
    // `inspectRemote`'s own silent `getToken(false)` (see `sync-harness.ts`) means settling
    // the interactive fetch first lets the whole connect run to completion in the same
    // microtask cascade, before `disconnect()` ever gets a turn. Disconnecting *first*
    // lands while `runConnect` still has that fetch outstanding, which is the one
    // interruption point this fake can still produce.
    //
    // Second, the destination: "idle" is also `stage`'s value before anything runs, so
    // even the reordered version above still passed with the guards gutted — this
    // `realBook()`-with-nothing-seeded-into-`repo` setup makes the apply fail with
    // BOOK_INVALID on its own, which also never touches `stage`. Seeding the Drive with a
    // file (`realBook()` on the local side keeps `firstConnectOptions` on the "choose"
    // side of the matrix, same as the first test in this block) means an unsuperseded
    // connect would reach `stage = {kind: "choosing", ...}` — a value teardown's own
    // `afterTeardown` does not produce — so "idle" here can only mean the connect never
    // got that far.
    const { session, auth, drive } = makeSession();
    drive.files.set("file-remote", JSON.stringify({ schema: "khesh.book.v1" }));
    session.setBook(realBook());
    const connecting = session.connect();
    await session.disconnect();
    await auth.tokenGate.settle(ok("token-1"));
    await connecting;
    expect(session.getSnapshot().stage.kind).toBe("idle");
  });
});
