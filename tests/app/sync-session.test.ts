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
    const beforeId = io().getFileId();
    await session.disconnect();
    expect(io().getFileId()).not.toBeNull();
    // Make the doomed write real, rather than stopping at `getToken`: `revoke()` in this
    // fake does not clear the cached token (see `createGatedAuth`'s own doc), so this
    // write does not fail on auth — it succeeds, against the *same* file the abandoned
    // connection already owned. That is BL-053's fix, not a gap in it: the old bug was a
    // shared ref going to null and a doomed write taking the create-a-new-file path
    // instead of this one.
    const doomedWrite = await drive.storeFor(io()).write(remotePayload());
    expect(doomedWrite.ok).toBe(true);
    expect(io().getFileId()).toBe(beforeId);
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

/** Settle every meta-store write currently parked on the gate, then flush, repeating until
 * nothing is left pending. The brief this suite comes from hard-codes a settle count; the
 * actual number of writes is an implementation detail (a first connect that has to create a
 * Drive file also persists that file's id, ahead of the write this task cares about), so
 * draining is what keeps these tests honest about what they pin — the final record, not a
 * guessed number of saves. */
async function drainMetaSaves(meta: ReturnType<typeof createGatedMetaStore>): Promise<void> {
  while (meta.saveGate.pending > 0) {
    await meta.saveGate.settle(undefined);
  }
}

describe("sync session: finalize and rollback", () => {
  it("persists the connection and arms the engine on the happy path", async () => {
    const { session, auth, meta, repo } = makeSession();
    // Deviates from the brief the same way `connectedSession()` does: `applyFirstConnect`
    // reads the book to upload from `repo.load()`, not from `setBook`'s argument. Without
    // this, `repo.load()` answers null, the apply fails with BOOK_INVALID, and the session
    // never reaches `connected: true` — see `connectedSession()`'s own note above.
    const book = emptyBook();
    await repo.save(book);
    session.setBook(book);
    const connecting = session.connect();
    await auth.tokenGate.settle(ok("token-1"));
    await connecting;
    expect(meta.record.connected).toBe(true);
    expect(meta.record.accountEmail).toBe("someone@example.com");
    expect(session.getSnapshot().connected).toBe(true);
    expect(session.getSnapshot().stage.kind).toBe("idle");
  });

  it("rolls back when the erase lands inside the finalize meta write — save first", async () => {
    // Deviates from the brief's statement order, confirmed necessary by running it: with an
    // empty local book and an empty Drive, `replaceRemote` has to create a Drive file, and
    // creating one persists its id (`ConnectionIO.onFileId`) — a `metaStore.save` of its own,
    // ahead of finalize's. Erasing immediately after the token settles (the brief's literal
    // order) lands that erase before this file-id write ever resolves, so `applyAndFinalize`
    // catches it at its own, pre-existing supersession check and never reaches `finalize` at
    // all. Draining the file-id write first, then erasing, is what parks the erase inside
    // finalize's own `metaStore.save({connected: true, ...})` instead — the window this
    // task's rollback exists for.
    //
    // "Save first" here means finalize's write is the one *issued* first and lands first,
    // uncontested, with the erase's own independent write landing right behind it — the
    // ordering a plain FIFO gate produces on its own. Mutating this rollback away still
    // leaves this test green (see the task report's mutation notes): the erase's own write,
    // arriving after regardless, already fixes the record on this ordering. It is kept
    // anyway as the companion proof to the test below — this ordering needs no rescue, the
    // other one does, and "the same answer either way" is a claim about both.
    const { session, auth, meta, repo } = makeSession();
    const book = emptyBook();
    await repo.save(book);
    session.setBook(book);
    meta.saveGate.manual();                  // hand timing to the test
    const connecting = session.connect();
    await auth.tokenGate.settle(ok("token-1"));
    // Parked inside the apply's own file-id write. Let it through so the connect reaches
    // finalize's write next.
    await meta.saveGate.settle(undefined);
    // Finalize's `metaStore.save({connected: true, accountEmail})` is now parked. Erase only
    // now, so its own write necessarily queues *behind* finalize's — and, left to settle in
    // that same order, lands behind it too.
    const erasing = session.disconnect();
    await drainMetaSaves(meta);
    await Promise.all([connecting, erasing]);
    expect(meta.record.connected).toBe(false);
    expect(session.getSnapshot().connected).toBe(false);
  });

  it("rolls back when the erase lands inside the finalize meta write — teardown first", async () => {
    // The landing order a plain FIFO gate cannot produce on its own, and the one this task's
    // whole claim rests on: `SyncMetaStore.save` is a non-atomic read-modify-write, so two
    // concurrent calls are not ordered by which was *issued* first, only by which one's
    // underlying write happens to *land* first. The erase's own write is issued second (it
    // cannot be issued at all until finalize's pre-write guard has already let finalize's own
    // write through), but real storage owes it no order — `Gate.settleLast` is what lets
    // this test make it land first anyway, exactly as an unlucky real one could. Finalize's
    // write then lands on top, and only its own post-write check, running after that write,
    // ever sees the erase again — the earlier guards already passed before the erase existed.
    // Mutating that check away turns this test red (see the task report's mutation notes):
    // nothing else left running still writes `connected: false` after finalize's own write
    // has landed.
    const { session, auth, meta, repo } = makeSession();
    const book = emptyBook();
    await repo.save(book);
    session.setBook(book);
    meta.saveGate.manual();
    const connecting = session.connect();
    await auth.tokenGate.settle(ok("token-1"));
    await meta.saveGate.settle(undefined);   // the apply's file-id write, out of the way
    // Finalize's write is parked (issued first). Erase now, then let its own write reach the
    // gate too, so both are pending together before either is let through.
    const erasing = session.disconnect();
    await flush();
    expect(meta.saveGate.pending).toBe(2);
    await meta.saveGate.settleLast(undefined); // the erase's write lands FIRST despite that
    expect(meta.record.connected).toBe(false); // intermediate: the erase, uncontested so far
    await drainMetaSaves(meta);                // finalize's write lands on top, then its own
    await Promise.all([connecting, erasing]);  // rollback lands last and wins
    expect(meta.record.connected).toBe(false);
    expect(session.getSnapshot().connected).toBe(false);
  });

  it("rolls back an erase that lands inside the apply itself", async () => {
    // Spec scenario 5. `applyFirstConnect` is Drive I/O plus a repo.save, so an erase can
    // begin inside it. The two things it must not go on to do are announce the book it
    // just restored — moments later `performReset` announces null, and whichever lands
    // last decides whether the user ends on onboarding or on the ledger they erased — and
    // persist `connected: true` over an engine aimed at the real Drive file.
    const announced: (Book | null)[] = [];
    const { session, auth, meta, drive } = makeSession({
      announceBookChanged: (b: Book | null) => announced.push(b),
    });
    drive.files.set("file-remote", remotePayload());
    session.setBook(emptyBook());
    const connecting = session.connect();
    await auth.tokenGate.settle(ok("token-1"));
    await connecting;
    const applying = session.applyChoice("useRemote");
    await session.disconnect();
    await applying;
    expect(announced).toEqual([]);
    expect(meta.record.connected).toBe(false);
    expect(session.getSnapshot().connected).toBe(false);
  });

  it("never persists a connection it cannot name", async () => {
    // BL-054. A finalize whose email fetch failed must not leave `connected: true` with a
    // null account behind it. Deviates from the brief by seeding `repo` (as above) and by
    // dropping the trailing `disconnect()`: with `fetchAccountEmail` and `metaStore.save`
    // both unblocked in this test, the whole connect runs to completion inside the token
    // settle's own flush, before a `disconnect()` placed after it would even start — so a
    // `disconnect()` there asserts nothing an already-clean record wouldn't already satisfy
    // on its own (confirmed by running it: the assertions below hold whether or not
    // `finalize` refuses, once a trailing `disconnect()` is there to clean up either way).
    // Asserting immediately after `connecting` resolves, with no teardown to fall back on,
    // is what actually pins the refusal.
    const { session, auth, meta, repo } = makeSession({
      fetchAccountEmail: async () => err<string>("SYNC_AUTH_REQUIRED", "gone"),
    });
    const book = emptyBook();
    await repo.save(book);
    session.setBook(book);
    const connecting = session.connect();
    await auth.tokenGate.settle(ok("token-1"));
    await connecting;
    expect(meta.record.connected).toBe(false);
    expect(meta.record.accountEmail).toBeNull();
  });

  it("does not open an OAuth popup for a connect an erase has already overtaken", async () => {
    // Defect 2. The old guard sat after getToken(true), so the user got a Google popup for
    // an operation that then silently did nothing.
    const { session, auth } = makeSession();
    session.setBook(emptyBook());
    void session.disconnect();               // bumps userEnds synchronously
    await session.connect();
    expect(auth.tokenGate.calls).toBe(0);
  });
});
