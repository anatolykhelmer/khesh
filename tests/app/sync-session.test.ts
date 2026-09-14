import { describe, expect, it } from "vitest";
import { createSyncSession, type ConnectionIO } from "../../src/app/sync/sync-session";
import {
  createFakeDrive,
  createGatedAuth,
  createGatedMetaStore,
  deferred,
  flush,
} from "../helpers/sync-harness";
import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { encodeEnvelope } from "../../src/adapters/sync-envelope";
import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import type { Book } from "../../src/kernel/types";
import { err, ok, type Result } from "../../src/kernel/result";
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

/**
 * A session parked on the choice screen with a plan that offers `useRemote` and
 * `replaceRemote` and **not** `merge`.
 *
 * `local = "empty"` is deliberate: `firstConnectOptions("real", book)` offers all three,
 * which would leave the refusal tests below with nothing to be refused. Against an empty
 * local book `merge` is withheld — it is the case that doubles the root accounts (BL-048).
 *
 * Deviates from the brief the same way `connectedSession()` does: also seeds `repo`, not
 * just `session.setBook()`. Found by mutation-testing the refusal test below — with the
 * `isChoiceOffered` guard gutted, `applyChoice("merge")` still left `meta.record.connected`
 * `false`, but for the wrong reason: `firstConnect`'s `merge` branch calls `loadLocal(repo)`
 * before it ever touches the remote, and an unseeded `repo` fails that with `BOOK_INVALID`
 * regardless of what the guard does. Seeding `repo` (with the same `emptyBook()` already
 * passed to `setBook`, so `localState()` still reads "empty" and the offered choices do
 * not change) is what lets a disabled guard actually reach the merge and turn the test red.
 */
async function choosingSession() {
  const h = makeSession();
  h.drive.files.set("file-remote", remotePayload());
  const book = emptyBook();
  await h.repo.save(book);
  h.session.setBook(book);
  const connecting = h.session.connect();
  await h.auth.tokenGate.settle(ok("token-1"));
  await connecting;
  expect(h.session.getSnapshot().stage.kind).toBe("choosing");
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
    //
    // What this test does *not* exercise: the `superseded(conn) ||` half of that check —
    // see "rolls back a connection whose book vanished mid-finalize" below, which pins it.
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

  it("rolls back a connection whose book vanished mid-finalize — the superseded(conn) case", async () => {
    // Carried debt from Task 3. Every test above reaches `finalize`'s rollback check
    // through `session.disconnect()`, which bumps `userEnds` and releases the connection
    // in the same synchronous prefix — so `superseded(conn)` and `userEnds !== endsAtStart`
    // always become true together, from the same event, and dropping `superseded(conn) ||`
    // from the check leaves every test above exactly as green as it is now.
    // `setBook(null)` is the first path that tears down with `cause: "bookVanished"`,
    // which by design does *not* bump `userEnds` (see `teardown`'s own doc on `userEnds`)
    // — the only way to make `superseded(conn)` fire on its own, with the other half of
    // the check staying false throughout.
    //
    // Built on `choosingSession()`, not a fresh `connect()`: for `setBook(null)` here to
    // tear anything down at all, `shouldTearDown` needs either `connected` or a live
    // `pendingInspection` — neither holds during a first-ever connect's own finalize,
    // since `connected` flips true only *after* the write this test parks inside. A
    // `choosing` screen supplies `pendingInspection` instead, and nothing clears `stage`
    // before finalize's own write resolves, so it is still live when the book vanishes.
    const { session, auth, meta } = await choosingSession();
    meta.saveGate.manual();
    const applying = session.applyChoice("useRemote");
    await flush();
    // `useRemote` reads a file id `choosingSession()`'s own connect already discovered, so
    // unlike the two tests above there is no extra file-id write ahead of finalize's own —
    // exactly one save is parked here.
    expect(meta.saveGate.pending).toBe(1);
    session.setBook(null);
    await flush();
    // `releaseConnection` marks the connection released synchronously, ahead of its own
    // await, so by this point finalize's `conn` is already superseded — but its own write
    // was issued first and is still the one sitting at the front of the queue. Landing the
    // teardown's write first is what makes finalize's *own* post-write check the one thing
    // standing between this and a persisted `connected: true` — same shape as "teardown
    // first" above, for the same reason.
    expect(meta.saveGate.pending).toBe(2);
    await meta.saveGate.settleLast(undefined); // the teardown's own write lands FIRST
    expect(meta.record.connected).toBe(false); // intermediate: uncontested so far
    await drainMetaSaves(meta);                // finalize's write lands on top, then its own
    await applying;
    expect(meta.record.connected).toBe(false);
    expect(session.getSnapshot().connected).toBe(false);

    // The other half of the carried debt: `userEnds` was never bumped by any of this, so
    // the Connect the drop notice goes on to ask for is not vetoed — it runs to a live
    // plan rather than being silently discarded by the `userEnds !== endsAtStart` check
    // inside `runConnect`, which would otherwise leave `stage` at the `idle` it starts
    // every connect from. Automatic again: this phase is not about save timing, and a
    // fresh connect against an unknown file id writes one of its own (`onFileId`), which
    // would otherwise park forever on the gate this test is done driving by hand.
    meta.saveGate.automatic(undefined);
    const connecting = session.connect();
    await auth.tokenGate.settle(ok("token-2"));
    await connecting;
    expect(session.getSnapshot().stage.kind).toBe("choosing");
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
    // BL-054, properly stated: "a connect that finalizes into a torn-down auth persists an
    // account it cannot name." `conn.auth` being non-null by construction (a fresh auth per
    // connection, never a shared ref that a teardown could null out from under this one)
    // already rules out the old `authRef.current!` crash. What is left, and what this test
    // pins, is the ordinary supersession check at the top of `finalize` —
    // `superseded(conn) || userEnds !== endsAtStart` — catching an email fetch that failed
    // because the *same* teardown about to release this connection also killed the auth it
    // reads through. A transient email failure with no teardown involved is a different,
    // deliberately *not* refused case — see the next test.
    //
    // Deviates from the brief: seeds `repo` (as above), and gates `fetchAccountEmail`
    // itself (a one-shot `deferred`, not a reusable `Gate`) instead of the brief's plain
    // failing async function — the brief's version resolves immediately, so nothing can
    // land *inside* the email fetch for a teardown to race against, and finalize's earlier,
    // pre-existing guard is exactly what this test needs to reach.
    const { promise: emailPromise, resolve: resolveEmail } = deferred<Result<string>>();
    const { session, auth, meta, repo } = makeSession({
      fetchAccountEmail: () => emailPromise,
    });
    const book = emptyBook();
    await repo.save(book);
    session.setBook(book);
    const connecting = session.connect();
    await auth.tokenGate.settle(ok("token-1"));
    // Finalize is now parked inside its own email fetch. Erase fully before failing it, so
    // the auth this fetch reads through is the one the erase has already torn down.
    await session.disconnect();
    resolveEmail(err("SYNC_AUTH_REQUIRED", "torn down"));
    await connecting;
    expect(meta.record.connected).toBe(false);
    expect(meta.record.accountEmail).toBeNull();
    expect(session.getSnapshot().connected).toBe(false);
  });

  it("persists a connection even when the email fetch fails without a teardown", async () => {
    // The case a refusal here would have wrongly caught too, and the repo owner's explicit
    // call: a transient failure of the userinfo endpoint, nothing else wrong — no teardown,
    // no supersession. `applyFirstConnect` has already written the user's book to Drive by
    // the time this runs, so tearing the connection down here would abandon a working
    // connection and a completed write over a network hiccup, and show the user an error
    // about an email fetch instead of about their data. `accountEmail: null` is the whole,
    // intended consequence — the connection still finalizes, arms its engine, and syncs.
    const { session, auth, meta, repo } = makeSession({
      fetchAccountEmail: async () => err<string>("SYNC_AUTH_REQUIRED", "userinfo hiccup"),
    });
    const book = emptyBook();
    await repo.save(book);
    session.setBook(book);
    const connecting = session.connect();
    await auth.tokenGate.settle(ok("token-1"));
    await connecting;
    await flush();                             // give the fire-and-forget syncNow() a turn
    expect(meta.record.connected).toBe(true);
    expect(meta.record.accountEmail).toBeNull();
    expect(session.getSnapshot().connected).toBe(true);
    expect(session.getSnapshot().email).toBeNull();
    expect(session.getSnapshot().state).not.toBeNull(); // armEngine's syncNow() actually ran
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

describe("sync session: applying a choice", () => {
  it("runs a choice the live plan offers and ends connected", async () => {
    const { session, auth, meta } = await choosingSession();
    await session.applyChoice("useRemote");
    expect(meta.record.connected).toBe(true);
    expect(session.getSnapshot().stage.kind).toBe("idle");
    void auth;
  });

  it("turns away a choice the live plan does not offer", async () => {
    // `choosingSession` plans against an empty local book, so the offer is
    // useRemote/replaceRemote and `merge` is withheld — running it anyway would perform
    // the write the plan deliberately declined (BL-048's doubled roots).
    const { session, meta } = await choosingSession();
    await session.applyChoice("merge");
    expect(meta.record.connected).toBe(false);
  });

  it("turns away a second tap while the first is still running", async () => {
    // Deviates from the brief in two ways, both found by running it as written.
    //
    // First, `await meta.saveGate.settle(undefined)` right after the two calls: neither
    // call reaches `metaStore.save` synchronously — `applyFirstConnect`'s `runExclusive`
    // (`serialLock`, this file) hands `firstConnect` to `chain.then(fn)`, and a `.then`
    // reaction is never run synchronously even against an already-resolved `chain`. With
    // nothing else awaited in between, the gate has nothing queued yet and `settle` throws
    // "no pending call". An `await flush()` first is what lets that pending write actually
    // reach the gate, the same way every other test in this block that stands inside a
    // write's own window gets there via a real `await` on a different gate first.
    //
    // Second, the bound itself: `choosingSession()`'s own `connect()` already spends one
    // call on this exact counter before this test ever runs — `inspectRemote`'s `read()`
    // discovers the seeded Drive file by name and persists its id (`ConnectionIO.onFileId`
    // → `metaStore.save`), in the gate's default automatic mode, ahead of `meta.saveGate.
    // manual()` below. An absolute `calls <= 2` counts that leftover call as one of the
    // two it means to bound, so it would still pass with `replaceRemote` sneaking a write
    // of its own past the guard. A delta from a baseline taken after setup is what actually
    // bounds *this test's own* writes: two is what the accepted `useRemote` legitimately
    // costs — finalize's `connected: true` write, and the fire-and-forget `syncNow()` a
    // healthy connect kicks off next — and a third would mean the refused tap wrote too.
    const { session, meta } = await choosingSession();
    meta.saveGate.manual();
    const callsBeforeTap = meta.saveGate.calls;
    const first = session.applyChoice("useRemote");
    const second = session.applyChoice("replaceRemote");   // both are offered here
    expect(session.getSnapshot().activity.applying).toBe(true);
    await flush();
    await meta.saveGate.settle(undefined);
    await Promise.all([first, second]);
    expect(meta.saveGate.calls - callsBeforeTap).toBeLessThanOrEqual(2);
  });

  it("does not claim to be connecting while a choice is being applied", async () => {
    // BL-052. One `applying` boolean was set by both connect() and applyChoice(), and
    // ConnectDrive's collapsed row keyed its "Connecting…" label on it — so a running
    // choice made the Connect button describe a write that was not a connect.
    //
    // Deviates from the brief: an `await flush()` ahead of `meta.saveGate.settle(undefined)`
    // — see the previous test's note. `applyChoice("useRemote")` has nothing synchronous
    // left to reach `metaStore.save` through; without a real `await` first, the gate has
    // nothing pending yet and `settle` throws.
    const { session, meta } = await choosingSession();
    meta.saveGate.manual();
    const running = session.applyChoice("useRemote");
    const activity = session.getSnapshot().activity;
    expect(activity.applying).toBe(true);
    expect(activity.connecting).toBe(false);
    expect(activity.blocking).toBe(true);
    await flush();
    await meta.saveGate.settle(undefined);
    await running;
  });

  it("announces the accepted choice through onStarted, and only the accepted one", async () => {
    const { session } = await choosingSession();
    const started: string[] = [];
    await session.applyChoice("merge", () => started.push("merge"));
    expect(started).toEqual([]);          // refused: never announced
    await session.applyChoice("useRemote", () => started.push("useRemote"));
    expect(started).toEqual(["useRemote"]);
  });

  it("cancelConnect clears the screen without releasing the connection", async () => {
    const { session } = await choosingSession();
    session.cancelConnect();
    expect(session.getSnapshot().stage.kind).toBe("idle");
    expect(session.getSnapshot().activity.blocking).toBe(false);
  });
});

describe("sync session: the book moving underneath", () => {
  it("resumes a stored connection once the book loads", async () => {
    const { session, meta } = makeSession({
      metaStore: createGatedMetaStore({ connected: true, fileId: "file-1", accountEmail: "a@b.c" }),
    });
    session.setBook(realBook());
    await flush();
    expect(session.getSnapshot().connected).toBe(true);
    expect(session.getSnapshot().email).toBe("a@b.c");
    void meta;
  });

  it("drops a plan the book moved out from under, and says so", async () => {
    // Deviates from the brief: `session.setBook(realBook())`, not a second `emptyBook()`.
    // `choosingSession()` plans from `local = "empty"` (see its own doc), so a second,
    // content-equal `emptyBook()` is still `localState() === "empty"` — the same string
    // `plannedFor` already holds, and `afterLocalStateChange` compares that string, not
    // book identity. The brief's own inline comment ("real → empty") describes the
    // opposite starting local state from what `choosingSession()` actually seeds; moving
    // to `realBook()` here is what actually changes `localState()` and exercises the drop.
    const { session } = await choosingSession();
    session.setBook(realBook());                  // "empty" → "real": the plan is stale
    expect(session.getSnapshot().stage.kind).toBe("dropped");
    expect(session.getSnapshot().lastError).toBeNull();
  });

  it("tears down when the book vanishes under a live connection", async () => {
    const { session, auth } = await connectedSession();
    session.setBook(null);
    await flush();
    expect(session.getSnapshot().connected).toBe(false);
    expect(auth.revokes).toBe(1);
  });

  it("a vanished book does not veto the Connect its own notice asks for", async () => {
    // The `bookVanished`/`userAction` distinction, guarded today by a comment alone. The
    // BL-050 spec names flattening it as a change the whole suite would survive.
    //
    // Deviates from the brief in two ways, both needed for the test to exercise what its
    // name claims.
    //
    // First, the base: `choosingSession()`, not `connectedSession()`. `connectedSession()`
    // ends at `stage: idle`, and `afterTeardown`'s own `kind` guard deliberately leaves an
    // `idle` teardown alone — its doc names this exactly: "a teardown that begins at
    // `idle` — the plain connected tab of BL-040, no plan ever offered — would otherwise
    // match itself and put the notice on a screen that never showed choices." Only a
    // `bookVanished` teardown that starts from a live `choosing` screen produces `dropped`,
    // which is also the only shape "the dropped-plan notice asks for exactly the Connect a
    // bump would veto" describes.
    //
    // Second, the final assertion: `stage.kind === "choosing"` after the second connect,
    // not stopping at `tokenGate.calls > 0`. `runConnect` calls `getToken(true)` before it
    // ever checks `userEnds`, so that call happening is true whether or not the guard
    // this test is about is correct — only reaching a live plan again, past the check a
    // wrongful bump would trip, is actual evidence.
    const { session, auth } = await choosingSession();
    session.setBook(null);
    await flush();
    expect(session.getSnapshot().stage.kind).toBe("dropped");
    const connecting = session.connect();
    expect(auth.tokenGate.calls).toBeGreaterThan(0);   // getToken(true) runs either way
    await auth.tokenGate.settle(ok("token-2"));
    await connecting;
    expect(session.getSnapshot().stage.kind).toBe("choosing");   // NOT vetoed
  });

  it("keeps erasing visible across a screen swap", async () => {
    // BL-055. The failing path is same-tab: performReset runs here, the book goes null
    // underneath it, App swaps Settings for OnboardingScreen, and the new screen's
    // ConnectDrive was gated on that screen's own writes only. Session state has no screen.
    const { session } = await connectedSession();
    session.beginErase();
    session.setBook(null);
    await flush();
    expect(session.getSnapshot().activity.erasing).toBe(true);
    expect(session.getSnapshot().activity.blocking).toBe(true);
    session.endErase();
    expect(session.getSnapshot().activity.blocking).toBe(false);
  });
});
