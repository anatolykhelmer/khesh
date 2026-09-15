import { describe, expect, it, vi } from "vitest";
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
import { EMPTY_SYNC_META, type SyncMeta, type SyncMetaStore } from "../../src/adapters/sync-meta-store";
import type { GoogleAuth } from "../../src/adapters/google-drive-sync";
import type { SyncStorePort } from "../../src/ports/sync-store";
import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import type { Book } from "../../src/kernel/types";
import { err, ok, type Result } from "../../src/kernel/result";
import { createSyncEngine, type SyncEngine, type SyncEngineDeps } from "../../src/service/sync-engine";
import { syncSignal } from "../../src/app/sync/sync-signal";
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

type RecordingEngine = {
  engine: SyncEngine;
  calls: string[];
  setReport: (fn: SyncEngineDeps["onStateChanged"]) => void;
};

/** A `SyncEngine` that records what it was asked to do and reports a *distinct* state on
 * every sync, through the `onStateChanged` the session hands it. Distinct because "the
 * sync ran" has to be visible in the snapshot and not only in a call count: the connect
 * that sets these tests up already runs one sync of its own, so a fixed state would make
 * the post-reauth assertion true before the reauth. */
function recordingEngine(): RecordingEngine {
  const calls: string[] = [];
  let syncs = 0;
  let report: SyncEngineDeps["onStateChanged"] = () => {};
  const engine: SyncEngine = {
    async syncNow() {
      syncs += 1;
      calls.push("syncNow");
      report({ kind: "idle", lastSyncAt: `sync-${syncs}` });
    },
    notifyLocalChange() {
      calls.push("notifyLocalChange");
    },
    async resolveUseLocal() {},
    async resolveUseRemote() {},
    getState: () => ({ kind: "idle", lastSyncAt: null }),
    dispose() {
      calls.push("dispose");
    },
  };
  return {
    engine,
    calls,
    setReport: (fn) => {
      report = fn;
    },
  };
}

/** A connected session whose engines are recording stand-ins, one per connection. The
 * connect's own fire-and-forget `syncNow()` has already run and been cleared from
 * `calls` by the time this returns; the snapshot therefore stands at `lastSyncAt: "sync-1"`. */
async function connectedWithRecordingEngines() {
  const engines: RecordingEngine[] = [];
  const h = makeSession({
    createEngine: (deps: SyncEngineDeps) => {
      const rec = recordingEngine();
      rec.setReport(deps.onStateChanged);
      engines.push(rec);
      return rec.engine;
    },
  });
  const book = emptyBook();
  await h.repo.save(book);
  h.session.setBook(book);
  const connecting = h.session.connect();
  await h.auth.tokenGate.settle(ok("token-1"));
  await connecting;
  await flush();                       // finalize's own fire-and-forget syncNow
  expect(h.session.getSnapshot().connected).toBe(true);
  expect(h.session.getSnapshot().state).toEqual({ kind: "idle", lastSyncAt: "sync-1" });
  engines[0].calls.length = 0;
  return { ...h, engines };
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

  it("a retry after a failed token releases the connection it displaces", async () => {
    // `openConnection` used to assign over `current` with no release, so a connect that
    // failed and was tried again left the first connection alive in every way that matters
    // — a GIS token nothing would ever revoke, and (further along the same three routes) an
    // engine nothing would dispose. Nothing else can reach it afterwards: it is no longer
    // `current`, so no teardown finds it.
    //
    // A failed `getToken` is the cheapest of the three routes: the failure itself releases
    // nothing (deliberately — the connection is still the session's, and inert), so the
    // retry's own claim on `current` is the only thing that can, and `revokes` counts it.
    // The claim is synchronous, which is why this is asserted before the second token even
    // settles.
    const { session, auth } = makeSession();
    session.setBook(emptyBook());
    const first = session.connect();
    await auth.tokenGate.settle(err("SYNC_AUTH_REQUIRED", "denied"));
    await first;
    expect(session.getSnapshot().lastError).not.toBeNull();
    expect(auth.revokes).toBe(0);                 // the failure alone lets go of nothing
    const second = session.connect();
    expect(auth.revokes).toBe(1);                 // …the retry's claim does
    await auth.tokenGate.settle(ok("token-2"));
    await second;
    expect(auth.revokes).toBe(1);                 // and only the one it displaced
  });

  it("a connect after cancelConnect releases the connection cancel left standing", async () => {
    // The second of the three routes, and the one `cancelConnect`'s own doc depends on:
    // it ends the flow *on screen* and deliberately releases nothing, on the promise that
    // "a connect that finishes afterwards finds itself superseded". That promise is only
    // kept if becoming superseded is also what ends the old connection.
    const { session, auth } = await choosingSession();
    session.cancelConnect();
    expect(auth.revokes).toBe(0);
    const connecting = session.connect();
    expect(auth.revokes).toBe(1);                 // the displaced connection, let go of
    await auth.tokenGate.settle(ok("token-2"));
    await connecting;
    expect(session.getSnapshot().stage.kind).toBe("choosing");   // and the new one works
  });

  it("an engine the session no longer speaks for cannot publish over the live one", async () => {
    // The other half of the same defect, and the one a revoke count cannot see. A displaced
    // engine keeps reporting through the `onStateChanged` the session handed it —
    // `dispose()` stops it taking new work, not the cycle already running — and that
    // callback wrote `engineState` and published unconditionally. The status row would then
    // show a released connection's sync state over the live connection's, and
    // `{lastSyncAt}` would reach the shared record from a connection nobody is using.
    const { session, meta, engines } = await connectedWithRecordingEngines();
    const displaced = engines[0];
    const before = session.getSnapshot().state;
    const savesBefore = meta.saveGate.calls;
    session.dispose();                            // releases the connection, engine included
    // The disposed engine, reporting one cycle late.
    displaced.engine.syncNow();
    await flush();
    expect(session.getSnapshot().state).toEqual(before);   // the snapshot did not move
    expect(meta.saveGate.calls).toBe(savesBefore);         // and nothing was persisted
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
    // The half the name claims and the four assertions above do not touch: "arms the
    // engine". `connected: true` is written by `finalize` two lines above `armEngine`, so
    // deleting the arming left every assertion here green and the user with a connected
    // session that never syncs. The engine's own first cycle reporting a state through
    // `onStateChanged` is the consequence — the same evidence the email-hiccup test below
    // already uses.
    await flush();
    expect(session.getSnapshot().state).not.toBeNull();
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
    // ordering a plain FIFO gate produces on its own. On this ordering the final record is
    // not evidence of anything: the erase's own write arrives after regardless and repairs
    // `connected: false` whether or not the rollback exists, and `drainMetaSaves` then hides
    // how many writes it took. Asserting it alone — which this test used to do — left it
    // green with the rollback mutated away, while its name promised rollback coverage.
    //
    // What the erase's write cannot fake is a *second* write of that field. The rollback is
    // a `teardown` of its own, so it issues its own `connected: false`; without it exactly
    // one is issued, by the erase. `meta.patches` records what each caller asked for, which
    // the record cannot, because two writes that agree leave one value behind.
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
    // Two teardowns wrote it: the erase's own, and the rollback's, which ran because
    // finalize's post-write check found the erase behind it.
    expect(meta.patches.filter((patch) => patch.connected === false)).toHaveLength(2);
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
    // The half this test used to stop short of, and the half BL-050 is actually about.
    // `connected: false` alone is also what the *silent* failure looks like: the user lands
    // back on onboarding with no notice and Connect looks like it did nothing. The teardown
    // wrote `dropped` while finalize was parked in its own meta write; finalize then
    // resumed and wrote `stage = IDLE` over it, and passed that already-clobbered `IDLE` as
    // `startedFrom`, so `afterTeardown` answered `idle` and the notice was lost. Restoring
    // the pre-claim stage before the rollback's teardown is what keeps it.
    expect(session.getSnapshot().stage.kind).toBe("dropped");
    // And what else the same defect moved: a `dropped` stage carries no error (see
    // `visibleError`), which holds whichever path wrote the drop.
    expect(session.getSnapshot().lastError).toBeNull();

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

  it("creates no engine on the rollback path", async () => {
    // Finding 8. `armEngine` sat above the post-write check, so a rollback armed an engine
    // on a connection `releaseConnection` had already nulled the engine field of — and the
    // rollback's own `teardown` releases `current`, which by then is no longer `conn`.
    // Measured before the fix as 1 created, 0 disposed: inert today, a bounded leak.
    //
    // Same shape as "save first" above: drain the apply's file-id write, then erase, so the
    // erase lands inside finalize's own `metaStore.save` and the rollback is what runs.
    let created = 0;
    let disposed = 0;
    const stubEngine: SyncEngine = {
      async syncNow() {},
      notifyLocalChange() {},
      async resolveUseLocal() {},
      async resolveUseRemote() {},
      getState: () => ({ kind: "idle", lastSyncAt: null }),
      dispose() {
        disposed += 1;
      },
    };
    const { session, auth, meta, repo } = makeSession({
      createEngine: () => {
        created += 1;
        return stubEngine;
      },
    });
    const book = emptyBook();
    await repo.save(book);
    session.setBook(book);
    meta.saveGate.manual();
    const connecting = session.connect();
    await auth.tokenGate.settle(ok("token-1"));
    await meta.saveGate.settle(undefined);   // the apply's file-id write, out of the way
    const erasing = session.disconnect();
    await drainMetaSaves(meta);
    await Promise.all([connecting, erasing]);
    expect(session.getSnapshot().connected).toBe(false);
    expect(created).toBe(0);                 // nothing armed
    expect(created).toBe(disposed);          // and so nothing left un-disposed
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

  it("refuses to start a connect while an erase is running", async () => {
    // The erase became session state precisely so this guard would stop depending on every
    // screen remembering it — `ConnectDrive`, `SyncSection` and `DangerZone` all read
    // `erasing` back as `activity.blocking` — but the session itself did not consult it.
    // `performReset` brackets its whole sequence with `beginErase`/`endErase`, and the
    // window that matters is after its `disconnect()` has resolved (so `disconnecting` is
    // false again) while `resetAll()` is still erasing the book.
    const { session, auth } = makeSession();
    session.setBook(emptyBook());
    session.beginErase();
    await session.connect();
    expect(auth.tokenGate.calls).toBe(0);                  // no popup, no connection opened
    expect(session.getSnapshot().stage.kind).toBe("idle");
  });

  it("does not open an OAuth popup for a reconnect an erase overtook inside its own write", async () => {
    // The same defect on the other route in. `runConnect`'s guard catches a teardown still
    // in flight, and its comment argued an `endsAtStart` capture there was pointless
    // because "there is no await between that bump and this line" — true for `connect()`,
    // false for `reconnect()`, which awaits `metaStore.save({fileId: null})` first. A
    // teardown that starts *and finishes* inside that write leaves `disconnecting` false
    // again by the time the guard runs, so nothing stops the popup.
    //
    // Landing the teardown's write first (`settleLast`) is what makes the window real: with
    // a plain FIFO settle the reconnect resumes while `disconnecting` is still true and the
    // existing guard covers it, which is why this test would be vacuous in issue order.
    const { session, auth, meta } = await connectedSession();
    await flush();                            // let finalize's own syncNow writes land
    meta.saveGate.manual();
    const callsBefore = auth.tokenGate.calls;
    const reconnecting = session.reconnect();
    await flush();
    expect(meta.saveGate.pending).toBe(1);    // reconnect's `fileId: null` write is parked
    const erasing = session.disconnect();     // bumps userEnds synchronously
    await flush();
    expect(meta.saveGate.pending).toBe(2);
    await meta.saveGate.settleLast(undefined); // the teardown's write lands first…
    await erasing;                             // …and the whole teardown completes
    await meta.saveGate.settle(undefined);     // only now does the reconnect resume
    await reconnecting;
    expect(auth.tokenGate.calls).toBe(callsBefore);   // no popup for an overtaken reconnect
    expect(session.getSnapshot().connected).toBe(false);
    expect(session.getSnapshot().stage.kind).toBe("idle");
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
    // Both fields this used to assert are already true on `choosingSession()`: the snapshot
    // stands at `stage: choosing` with nothing running, so `blocking` is false before the
    // cancel and `idle` is what a `cancelConnect` that tore the connection down would leave
    // behind too. Neither says the connection survived, which is the whole claim in the
    // name — and `cancelConnect` is the unguarded writer the `visibleError` rule leans on,
    // so what it does and does not touch matters.
    //
    // The consequence instead: nothing was revoked, and a `disconnect` afterwards still has
    // something to let go of. (Not "a later `applyChoice` finishes" — the cancel clears the
    // stage, so `isChoiceOffered` turns every choice away by design.)
    const { session, auth } = await choosingSession();
    session.cancelConnect();
    expect(session.getSnapshot().stage.kind).toBe("idle");
    expect(session.getSnapshot().activity.blocking).toBe(false);
    expect(auth.revokes).toBe(0);
    await session.disconnect();
    expect(auth.revokes).toBe(1);
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

  it("does not commit a resumed connection whose book vanished while the load was in flight", async () => {
    // Reviewer-found gap in Task 5. `resumeStoredConnection`'s callback guarded only
    // `!meta.connected || connected` — not the book having vanished *while the load
    // itself was pending*. `shouldTearDown` cannot see that window: it only tears a
    // connection down once one exists (`connected` or a live `pendingInspection`), and
    // during this load neither does yet, so `setBook(null)` arriving mid-load is a no-op
    // there (see the "does not veto" test above for the same gate, exercised the other
    // way). Nothing afterwards corrects it either — a later `setBook` call, vanish or
    // reload, reads `previous` as already `null` and is a no-op in `shouldTearDown` for
    // that reason too. Without the fix this callback commits `connected: true` bound to a
    // stale `fileId`, with a live engine, over a book that is null — the BL-040/BL-055
    // class this task exists to close, reopened through the one path it adds.
    //
    // A one-shot `deferred`, not `createGatedMetaStore`, because the harness's meta-store
    // fake only gates `save`, not `load` — nothing else in this file has needed to hold a
    // `load()` open before.
    const { promise: loadPromise, resolve: resolveLoad } = deferred<SyncMeta>();
    const { session } = makeSession({
      metaStore: { load: () => loadPromise, save: async () => {} },
    });
    session.setBook(realBook());   // starts the resume load, `resumed` latches
    session.setBook(null);         // arrives before the load resolves; shouldTearDown is a no-op
    resolveLoad({ connected: true, fileId: "file-1", accountEmail: "a@b.c", lastSyncAt: null });
    await flush();
    expect(session.getSnapshot().connected).toBe(false);
    expect(session.getSnapshot().state).toBeNull();   // armEngine never ran
  });

  it("refuses to resume into an erase, and asks again once the erase ends", async () => {
    // `runConnect` is refused outright while `erasing` because no screen can be trusted to
    // hold that line. Resume is the other path that *commits* a connection — it arms an
    // engine at the user's real Drive file — and it consulted nothing but `meta.connected`
    // and the book. `performReset` skips its own `disconnect()` whenever the React snapshot
    // still reads `connected === false`, which is exactly the state a tab that has not
    // resumed yet is in, so a stored resume landing inside the `resetAll()` window armed an
    // engine at the real file while the book was being erased: BL-040's window, reopened
    // through the one path this session adds.
    //
    // The second half is the latch. `resumed` was set on entry, before the load, so this
    // refusal — like a thrown `load()` or a book that vanished under one — left the stored
    // connection unadoptable for the life of the tab. A refusal is not an answer.
    const { session } = makeSession({
      metaStore: createGatedMetaStore({ connected: true, fileId: "file-1", accountEmail: "a@b.c" }),
    });
    session.beginErase();
    session.setBook(realBook());
    await flush();
    expect(session.getSnapshot().connected).toBe(false);
    expect(session.getSnapshot().state).toBeNull();      // armEngine never ran
    session.endErase();
    session.setBook(realBook());                         // the next book to arrive asks again
    await flush();
    expect(session.getSnapshot().connected).toBe(true);
    expect(session.getSnapshot().email).toBe("a@b.c");
  });

  it("refuses to resume over a connect already in flight", async () => {
    // Both commit a connection, and `openConnection` is an exclusive claim, so whichever
    // runs second ends the other's. The resume must not be that second one: it would
    // release a connect the user is standing in front of — a popup already answered — and
    // replace it with a record written before this tab started.
    const { promise: loadPromise, resolve: resolveLoad } = deferred<SyncMeta>();
    const h = makeSession({ metaStore: { load: () => loadPromise, save: async () => {} } });
    const book = emptyBook();
    await h.repo.save(book);
    h.session.setBook(book);                    // starts the resume load
    const connecting = h.session.connect();     // claims `current` while it is in flight
    resolveLoad({ connected: true, fileId: "file-1", accountEmail: "a@b.c", lastSyncAt: null });
    await flush();
    expect(h.session.getSnapshot().connected).toBe(false);   // the resume did not commit
    await h.auth.tokenGate.settle(ok("token-1"));
    await connecting;
    expect(h.session.getSnapshot().connected).toBe(true);
    // Whose connection it is, which `connected` alone cannot say: the connect's own email,
    // not the stored record's.
    expect(h.session.getSnapshot().email).toBe("someone@example.com");
  });

  it("refuses to resume while a disconnect is still landing", async () => {
    // `performStartOver`: `disconnect()` runs unconditionally while the book is null, then
    // onboarding's Continue brings a book in and the resume asks a record whose
    // `connected: false` the teardown has issued but not yet landed. Adopting there arms an
    // engine the teardown can never dispose — it captured `current` as null at its start —
    // so the session ends disconnected with a live engine still syncing the book the user
    // just walked away from. The count is what sees it: the teardown's own tail rewrites
    // every snapshot field this would otherwise show up in.
    let armed = 0;
    const meta = createGatedMetaStore({ connected: true, fileId: "file-1", accountEmail: "a@b.c" });
    const { session } = makeSession({
      metaStore: meta,
      createEngine: () => {
        armed += 1;
        return {
          async syncNow() {},
          notifyLocalChange() {},
          async resolveUseLocal() {},
          async resolveUseRemote() {},
          getState: () => ({ kind: "idle", lastSyncAt: null }),
          dispose() {},
        } satisfies SyncEngine;
      },
    });
    meta.saveGate.manual();
    const disconnecting = session.disconnect();
    await flush();
    expect(meta.saveGate.pending).toBe(1);      // parked in the teardown's own meta write
    session.setBook(realBook());
    await flush();
    expect(session.getSnapshot().connected).toBe(false);
    await drainMetaSaves(meta);
    await disconnecting;
    expect(armed).toBe(0);
    expect(meta.record.connected).toBe(false);
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

  it("a teardown-written drop clears the error under it, so nothing resurfaces", async () => {
    // The state half of the `visibleError` rule. The old provider cleared `lastError`
    // whenever `stage.kind === "dropped"`, keyed on the stage and placed above the
    // transition's early return. In the session the clear had moved *below* that return —
    // so it fired only for drops `applyStalenessGate` itself derived, and a `DROPPED`
    // written by `teardown` (which reaches the gate as a no-op transition) left the error
    // set. `visibleError` hides it while the stage is `dropped`; the resurfacing is what
    // this pins — `cancelConnect()`, which `performReset` calls, moves the stage off
    // `dropped` without touching `lastError`.
    //
    // Reaching (`choosing`, error set) needs an offered choice that fails. `inspectRemote`
    // reads once to build the plan; this store lets that through and fails every read
    // after, so `applyFirstConnect("useRemote")` fails on its own first statement with the
    // plan still live.
    const drive = createFakeDrive();
    drive.files.set("file-remote", remotePayload());
    const { session, auth } = makeSession({
      createStore: (io: ConnectionIO) => {
        const inner = drive.storeFor(io);
        let reads = 0;
        return {
          probe: () => inner.probe(),
          read: async () => {
            reads += 1;
            return reads === 1 ? inner.read() : err("SYNC_STORE_FAILED", "read failed");
          },
          write: (payload: string) => inner.write(payload),
        };
      },
    });
    const book = emptyBook();
    session.setBook(book);
    const connecting = session.connect();
    await auth.tokenGate.settle(ok("token-1"));
    await connecting;
    expect(session.getSnapshot().stage.kind).toBe("choosing");

    await session.applyChoice("useRemote");
    expect(session.getSnapshot().stage.kind).toBe("choosing");   // the plan survives it
    const failure = session.getSnapshot().lastError;
    expect(failure).not.toBeNull();                              // and shows the failure

    session.setBook(null);                                       // teardown: bookVanished
    await flush();
    expect(session.getSnapshot().stage.kind).toBe("dropped");
    expect(session.getSnapshot().lastError).toBeNull();          // hidden either way

    session.cancelConnect();                                     // off `dropped`
    expect(session.getSnapshot().stage.kind).toBe("idle");
    expect(session.getSnapshot().lastError).toBeNull();          // and does not come back
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

describe("sync session: the rest of the surface", () => {
  it("reauth takes an interactive token and syncs on success", async () => {
    // The assertion this test used to carry — `tokenGate.calls > 0` — was already true from
    // `connectedSession()`'s own setup, so deleting `await conn.engine?.syncNow()` from
    // `reauth` left it green. What reauth promises is a *fresh interactive* token and a
    // sync on the far side of it, and the sync is observable: the engine reports a state
    // and the session publishes it.
    const { session, auth, engines } = await connectedWithRecordingEngines();
    const callsBefore = auth.tokenGate.calls;
    const running = session.reauth();
    expect(auth.tokenGate.calls).toBe(callsBefore + 1);   // interactive: bypasses the cache
    await auth.tokenGate.settle(ok("token-2"));
    await running;
    expect(engines[0].calls).toEqual(["syncNow"]);
    // Moved, from the `sync-1` the setup connect left behind.
    expect(session.getSnapshot().state).toEqual({ kind: "idle", lastSyncAt: "sync-2" });
  });

  it("a reconnect releases the connection it displaces, and a late reauth cannot revive it", async () => {
    // This test used to document the leak as the intended way to reach `superseded(conn)`
    // inside `reauth`: "`reconnect()` is the supersession that leaves the abandoned
    // connection's engine intact". That was the defect, not a fixture. `reconnect` — and
    // `openConnection` behind it — now releases the connection it displaces, so the claim
    // to assert is the release itself: the old engine is disposed, and the old auth's token
    // is revoked, before the replacement ever opens its popup.
    //
    // What the `superseded(conn)` check in `reauth` is worth after that, stated honestly:
    // nothing independently observable. `releaseConnection` nulls `conn.engine` in the same
    // synchronous prefix, so the `conn.engine?.syncNow()` below the check is inert on every
    // path that reaches it — the same reason the check could not be pinned through
    // `disconnect()` either. It stays as defence against a future release that stops
    // nulling the engine; the assertion that would actually fail is the one below it.
    const { session, auth, engines } = await connectedWithRecordingEngines();
    const revokesBefore = auth.revokes;
    const running = session.reauth();                  // interactive token, queued first
    await flush();
    expect(auth.tokenGate.pending).toBe(1);
    const reconnecting = session.reconnect();          // opens a second connection
    await flush();
    expect(auth.tokenGate.pending).toBe(2);
    expect(engines.length).toBe(1);                    // the new one is not armed yet
    expect(engines[0].calls).toEqual(["dispose"]);     // …and the old one is gone
    expect(auth.revokes).toBe(revokesBefore + 1);      // token included
    await auth.tokenGate.settle(ok("token-2"));        // the reauth's own token, at last
    await running;
    expect(engines[0].calls).toEqual(["dispose"]);     // no sync on the released one
    await auth.tokenGate.settle(ok("token-3"));        // let the reconnect finish cleanly
    await reconnecting;
  });

  it("a reconnect an erase refuses still lets go of the connection it was leaving", async () => {
    // Why `reconnect` releases the old connection itself instead of leaving it to
    // `openConnection`'s claim: `runConnect` can decline to start at all. There is no await
    // between the `userEnds` check below the `fileId: null` write and `openConnection`, so
    // on every path where the connect *runs* the two are the same moment and either would
    // do — but a refusal means no claim is ever made, and the old engine would stay armed
    // at the real Drive file with the persisted address already cleared.
    //
    // The refusal that matters is `erasing`: `performReset` skips its own `disconnect()`
    // whenever the React snapshot still reads `connected === false`, so an erase can be
    // running with a live connection nothing has torn down. The engine has to go, and the
    // reconnect must not open a popup on top of the erase.
    const { session, auth, meta, engines } = await connectedWithRecordingEngines();
    await flush();
    meta.saveGate.manual();
    const tokenCallsBefore = auth.tokenGate.calls;
    const reconnecting = session.reconnect();
    await flush();
    expect(meta.saveGate.pending).toBe(1);          // parked in the `fileId: null` write
    session.beginErase();
    await meta.saveGate.settle(undefined);          // the write lands; the reconnect resumes
    await reconnecting;
    expect(auth.tokenGate.calls).toBe(tokenCallsBefore);   // refused: no OAuth popup
    expect(engines[0].calls).toEqual(["dispose"]);         // and nothing left armed
    expect(auth.revokes).toBe(1);
  });

  it("a doomed write across a reconnect cannot mint a second Drive file", async () => {
    // BL-053, on the one path that still reopened it. `reconnect` used to null
    // `current.fileId` on a connection that is live by definition — its only call site is
    // the connected `SYNC_FILE_MISSING` row — and the old engine's store reads exactly that
    // field. An in-flight or debounced cycle then finds null and takes `write`'s
    // create-a-new-file path; two `khesh-book.json` is `SYNC_FILE_AMBIGUOUS`, which the app
    // cannot recover from. Same assertion shape the `disconnect` test above already makes,
    // on the flow that actually wants the id forgotten.
    //
    // The write has to go through the *displaced* connection's own io, captured before the
    // reconnect opens its replacement — `io()` hands back the most recent one.
    const { session, auth, drive, io, meta } = await connectedSession();
    await flush();                                // finalize's own syncNow, out of the way
    const before = drive.files.size;
    const staleIo = io();
    const staleId = staleIo.getFileId();
    expect(staleId).not.toBeNull();
    const reconnecting = session.reconnect();
    await flush();                                // past the `fileId: null` meta write
    expect(meta.record.fileId).toBeNull();         // the persisted address really is gone…
    expect(staleIo.getFileId()).toBe(staleId);     // …and the abandoned connection keeps its own
    const doomed = await drive.storeFor(staleIo).write(remotePayload());
    expect(doomed.ok).toBe(true);                  // it still writes: revoke does not fail it
    expect(drive.files.size).toBe(before);         // but into the file it already owned
    await auth.tokenGate.settle(ok("token-2"));
    await reconnecting;
  });

  it("an abandoned connect's file id never reaches the shared meta record", async () => {
    // `ConnectionIO.onFileId` writes two places, and only one of them belongs to the
    // connection: `conn.fileId` is the in-flight write's own id (BL-053 again — the doomed
    // write above depends on it), while `SyncMeta.fileId` is one slot for the whole tab.
    // Persisting unconditionally meant an abandoned connect that discovered or created a
    // file wrote its id over the live connection's, and the next boot resumed at whichever
    // landed last.
    const { session, auth, drive, meta, io } = makeSession();
    session.setBook(emptyBook());
    const connecting = session.connect();          // opens the connection, parks on getToken
    const staleIo = io();
    await session.disconnect();                    // it is abandoned before it ever inspects
    await auth.tokenGate.settle(ok("token-1"));
    await connecting;
    expect(meta.record.fileId).toBeNull();
    // The write that grabbed this store before the teardown, running on: no id of its own
    // and an empty Drive, so it takes the create path and reports the id it minted.
    const doomed = await drive.storeFor(staleIo).write(remotePayload());
    expect(doomed.ok).toBe(true);
    expect(drive.files.size).toBe(1);
    expect(staleIo.getFileId()).not.toBeNull();    // kept in memory, where the write needs it
    expect(meta.record.fileId).toBeNull();         // and nowhere near the shared record
  });

  it("a reauth whose token lands after a disconnect neither syncs nor revives the session", async () => {
    const { session, auth, engines } = await connectedWithRecordingEngines();
    const running = session.reauth();
    await flush();
    expect(auth.tokenGate.pending).toBe(1);
    await session.disconnect();
    await auth.tokenGate.settle(ok("token-2"));
    await running;
    // `dispose` and nothing after it: the teardown disposed the engine, and the late token
    // did not start a sync on it.
    expect(engines[0].calls).toEqual(["dispose"]);
    expect(session.getSnapshot().connected).toBe(false);
    expect(session.getSnapshot().state).toBeNull();
  });

  it("reauth on a disconnected session does nothing and does not throw", async () => {
    const { session } = makeSession();
    await expect(session.reauth()).resolves.toBeUndefined();
  });

  it("dispose releases the connection and stops notifying", async () => {
    // "Releases the connection" was in the name and nowhere in the assertions: only the
    // silence was checked, so gutting `releaseConnection` out of `dispose` left this green.
    // Both halves now, and the release half is the one with teeth — `dispose` is what
    // `SyncProvider` no longer calls from an effect cleanup precisely because it revokes.
    const { session, auth, engines } = await connectedWithRecordingEngines();
    let notified = 0;
    session.subscribe(() => { notified += 1; });
    session.dispose();
    await flush();
    expect(engines[0].calls).toEqual(["dispose"]);
    expect(auth.revokes).toBe(1);
    session.beginErase();
    expect(notified).toBe(0);
  });

  it("no method rejects, whatever the ports do", async () => {
    // The class of bug that produced "an unhandled rejection in an app with no error
    // boundary": applyChoice is invoked as `void sync.applyChoice(…)`, so anything thrown
    // inside it reaches nobody.
    const throwing = { async getToken() { throw new Error("boom"); },
                       async revoke() { throw new Error("boom"); } };
    const { session } = makeSession({
      createAuth: () => throwing,
      metaStore: { async load() { throw new Error("boom"); },
                   async save() { throw new Error("boom"); } },
      fetchAccountEmail: async () => { throw new Error("boom"); },
    });
    session.setBook(realBook());
    await expect(session.connect()).resolves.toBeUndefined();
    await expect(session.reconnect()).resolves.toBeUndefined();
    await expect(session.applyChoice("merge")).resolves.toBeUndefined();
    await expect(session.disconnect()).resolves.toBeUndefined();
    await expect(session.reauth()).resolves.toBeUndefined();
    expect(session.getSnapshot().connected).toBe(false);
  });
});

/**
 * The brief's own "no method rejects" test breaks every port at once. That is exactly
 * what the task brief warns against as a weak proof: with `auth.getToken` throwing
 * immediately, `runConnect` never gets far enough to reach `metaStore.save`,
 * `fetchAccountEmail`, or `auth.revoke` at all — so a single combined run can pass even
 * if the catches around *those* calls were never written. This suite makes each port
 * fail on its own, with the rest of the ports working normally, so every method's own
 * catch has to earn its pass individually. `emptyBook()` + a seeded `repo`, not
 * `realBook()` with nothing seeded: that is what lets `applyFirstConnect` actually
 * succeed and the flow reach `finalize` (and, through a second `reconnect()`, `teardown`)
 * instead of dying early on `BOOK_INVALID` regardless of which port is broken.
 */
describe("sync session: port-failure sweep", () => {
  const boom = new Error("boom");

  type BrokenPort =
    | "auth.getToken"
    | "auth.revoke"
    | "metaStore.load"
    | "metaStore.save"
    | "fetchAccountEmail"
    | "store";

  async function makeBrokenSession(broken: BrokenPort) {
    const auth: GoogleAuth = {
      async getToken() {
        if (broken === "auth.getToken") throw boom;
        return ok("token");
      },
      async revoke() {
        if (broken === "auth.revoke") throw boom;
      },
    };
    const metaStore: SyncMetaStore = {
      async load() {
        if (broken === "metaStore.load") throw boom;
        return { ...EMPTY_SYNC_META };
      },
      async save() {
        if (broken === "metaStore.save") throw boom;
      },
    };
    const fetchAccountEmail = async () => {
      if (broken === "fetchAccountEmail") throw boom;
      return ok("someone@example.com");
    };
    const brokenStore: SyncStorePort = {
      async probe() { throw boom; },
      async read() { throw boom; },
      async write() { throw boom; },
    };
    const drive = createFakeDrive();
    const h = makeSession({
      createAuth: () => auth,
      createStore: (io: ConnectionIO) => (broken === "store" ? brokenStore : drive.storeFor(io)),
      metaStore,
      fetchAccountEmail,
    });
    const book = emptyBook();
    await h.repo.save(book);
    h.session.setBook(book);
    return h;
  }

  it.each<BrokenPort>([
    "auth.getToken",
    "auth.revoke",
    "metaStore.load",
    "metaStore.save",
    "fetchAccountEmail",
    "store",
  ])("no method rejects when only %s throws", async (broken) => {
    // Carried defect (b). Every assertion below only checks that the promise resolves,
    // so a `swallow` mutant that empties its body — the exact silent catch the module
    // doc forbids — stayed green. `console.error` is the one observable side effect
    // `swallow` promises; a spy on it is what actually holds that promise to account.
    //
    // Carried defect (c). Scenario 13 promised "no session method rejects **and the
    // snapshot settles into a coherent state**", and this sweep asserted only the first
    // half. `teardown` was `try`/`finally` with no `catch` and `await releaseConnection`
    // as its first statement, so a rejecting `revoke()` skipped the meta write and every
    // state write below it — leaving the app showing "Synced" over a released connection,
    // with a persisted record still saying connected for the next boot to resume. The
    // promise resolved the whole time.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { session } = await makeBrokenSession(broken);
      await expect(session.connect(), broken).resolves.toBeUndefined();
      await expect(session.reconnect(), broken).resolves.toBeUndefined();
      await expect(session.applyChoice("merge"), broken).resolves.toBeUndefined();
      await expect(session.disconnect(), broken).resolves.toBeUndefined();
      await expect(session.reauth(), broken).resolves.toBeUndefined();
      expect(consoleError, broken).toHaveBeenCalled();
      // The other half of the promise. A `disconnect()` that returned is not the claim;
      // a `disconnect()` that actually left the session disconnected, with nothing latched
      // on, is.
      const snap = session.getSnapshot();
      expect(snap.connected, broken).toBe(false);
      expect(snap.email, broken).toBeNull();
      expect(snap.state, broken).toBeNull();
      expect(snap.activity, broken).toEqual({
        connecting: false,
        applying: false,
        disconnecting: false,
        erasing: false,
        blocking: false,
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a teardown whose meta write rejects still leaves the session disconnected", async () => {
    // The `auth.revoke` row of the sweep above, one line further down — and a gap those
    // rows cannot close. The teardown's tail sat below *two* unguarded awaits, and the
    // sweep can only ever reach the first: a `metaStore.save` that is broken from the start
    // is also the write `finalize` claims the connection through, so the session never
    // becomes connected and a stranded `connected: true` has nothing to be stranded from.
    // Breaking the port only once the connection is live is what puts the teardown's tail
    // behind a rejecting write with something real to undo.
    const record: SyncMeta = { ...EMPTY_SYNC_META };
    let failing = false;
    const metaStore: SyncMetaStore = {
      async load() {
        return { ...record };
      },
      async save(patch) {
        if (failing) throw boom;
        Object.assign(record, patch);
      },
    };
    const { session, auth, repo } = makeSession({ metaStore });
    const book = emptyBook();
    await repo.save(book);
    session.setBook(book);
    const connecting = session.connect();
    await auth.tokenGate.settle(ok("token-1"));
    await connecting;
    await flush();
    expect(session.getSnapshot().connected).toBe(true);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      failing = true;
      await expect(session.disconnect()).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalled();          // never silent
      expect(auth.revokes).toBe(1);                     // the token really is gone…
      expect(session.getSnapshot().connected).toBe(false);   // …and the app says so
      expect(session.getSnapshot().email).toBeNull();
      expect(session.getSnapshot().state).toBeNull();
      expect(session.getSnapshot().activity.disconnecting).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  // The gap the six rows above cannot close on their own: with an empty local book,
  // `firstConnectOptions` auto-applies on the first connect (no `choosing` stage), and
  // `applyChoice("merge")` is therefore always refused by its own `isChoiceOffered` guard
  // before it ever touches `applyAndFinalize` — so `applyChoice`'s *own* try/catch, as
  // opposed to `connect`'s, is never actually exercised above. This test reaches
  // `choosing` first (real local + a seeded remote, `choosingSession()`'s own shape) and
  // then taps an offered choice whose `finalize` throws, which is the only way to put a
  // throw inside `applyChoice`'s own try block rather than `runConnect`'s.
  it("applyChoice's own catch: resolves even when finalize's account-email fetch throws mid-apply", async () => {
    const { session, auth, drive, repo } = makeSession({
      fetchAccountEmail: async () => {
        throw boom;
      },
    });
    drive.files.set("file-remote", remotePayload());
    const book = emptyBook();
    await repo.save(book);
    session.setBook(book);
    const connecting = session.connect();
    await auth.tokenGate.settle(ok("token-1"));
    await connecting;
    expect(session.getSnapshot().stage.kind).toBe("choosing");
    await expect(session.applyChoice("useRemote")).resolves.toBeUndefined();
    expect(session.getSnapshot().connected).toBe(false);
  });

  // A gap none of the rows above reach: `armEngine`'s `onStateChanged` callback fires a
  // fire-and-forget `metaStore.save({ lastSyncAt })` whenever a sync cycle finishes, from
  // deep inside the engine — not from any awaited chain a public method's own try/catch
  // could see. A `metaStore` that only fails *that* call (and succeeds for the writes
  // `connect`/`finalize` make on the way there) is what is needed to reach it at all.
  it("does not produce an unhandled rejection when the post-sync lastSyncAt write fails", async () => {
    const metaStore: SyncMetaStore = {
      async load() {
        return { ...EMPTY_SYNC_META };
      },
      async save(patch) {
        if ("lastSyncAt" in patch) throw boom;
      },
    };
    const { session, auth, repo } = makeSession({ metaStore });
    const book = emptyBook();
    await repo.save(book);
    session.setBook(book);
    const connecting = session.connect();
    await auth.tokenGate.settle(ok("token-1"));
    await connecting;
    expect(session.getSnapshot().connected).toBe(true);
    // `finalize`'s own fire-and-forget `syncNow()` already ran a full cycle against the
    // now-broken `metaStore.save` by this point; a second, explicit `syncNow()` exercises
    // the same path again. Nothing here asserts on `state` — the point is that vitest's
    // own "Unhandled Rejection" detector (which the earlier RED run in this task's report
    // demonstrated is real, not hypothetical) stays silent.
    await flush();
    session.syncNow();
    await flush();
  });
});

describe("sync session: window and signal wiring", () => {
  /** `environment: "node"` means `document`/`window` do not exist unless a test defines
   * them — which is also why `attach` guards on `typeof document`/`typeof window` in the
   * first place. Stubbing minimal fakes is what lets "the detach removes what attach
   * added" be checked directly instead of only inferred from "no crash under node". */
  function stubDomListeners() {
    const docListeners = new Map<string, () => void>();
    const winListeners = new Map<string, () => void>();
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: (type: string, fn: () => void) => docListeners.set(type, fn),
      removeEventListener: (type: string, fn: () => void) => {
        if (docListeners.get(type) === fn) docListeners.delete(type);
      },
    });
    vi.stubGlobal("window", {
      addEventListener: (type: string, fn: () => void) => winListeners.set(type, fn),
      removeEventListener: (type: string, fn: () => void) => {
        if (winListeners.get(type) === fn) winListeners.delete(type);
      },
    });
    return { docListeners, winListeners };
  }

  it("attach adds the window listeners, its detach removes them, and a re-attach restores them", () => {
    // The re-attach is the point. These used to be wired at construction and removed in
    // `dispose()`, which the provider calls from an effect cleanup — while the session
    // itself lives in a ref that survives the cycle. React's StrictMode dev mount is
    // setup → cleanup → setup, so after the first dev remount both listeners (and the
    // local-commit subscription below) were gone for good. Production never saw it: the
    // provider is at the root and never unmounts. Dev is the only place this seam is ever
    // verified against real Google.
    const { docListeners, winListeners } = stubDomListeners();
    try {
      const { session } = makeSession();
      expect(docListeners.has("visibilitychange")).toBe(false);   // not at construction
      expect(winListeners.has("online")).toBe(false);

      const detach = session.attach();
      expect(docListeners.has("visibilitychange")).toBe(true);
      expect(winListeners.has("online")).toBe(true);

      detach();
      expect(docListeners.has("visibilitychange")).toBe(false);
      expect(winListeners.has("online")).toBe(false);

      const detachAgain = session.attach();                       // the StrictMode remount
      expect(docListeners.has("visibilitychange")).toBe(true);
      expect(winListeners.has("online")).toBe(true);

      // And the ownership split: `dispose()` owns the connection and this session's own
      // subscribers, not the page-level listeners. Undoing them there is what the remount
      // turned permanent.
      session.dispose();
      expect(docListeners.has("visibilitychange")).toBe(true);
      expect(winListeners.has("online")).toBe(true);
      detachAgain();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the attached local-commit signal reaches the live engine, and stops at detach", async () => {
    // `syncSignal.emit` is the only path from a local commit to the engine's
    // `notifyLocalChange()`, and nothing tested it at all. Detaching and re-attaching is
    // the StrictMode cycle again: a dev remount that left this unsubscribed meant every
    // edit the user made stopped reaching Drive until the tab was reloaded.
    const { session, engines } = await connectedWithRecordingEngines();
    const detach = session.attach();
    syncSignal.emit(realBook());
    expect(engines[0].calls).toEqual(["notifyLocalChange"]);

    detach();
    syncSignal.emit(realBook());
    expect(engines[0].calls).toEqual(["notifyLocalChange"]);      // nothing more

    const detachAgain = session.attach();
    syncSignal.emit(realBook());
    expect(engines[0].calls).toEqual(["notifyLocalChange", "notifyLocalChange"]);
    detachAgain();
  });

  it("the attached visibility and online listeners sync the live connection", async () => {
    // What those two listeners are for, which "the listener is registered" does not say.
    // Reachable now only because `attach` — not construction — is what reads the globals,
    // so the session can be built and connected before they are stubbed.
    const { session, engines } = await connectedWithRecordingEngines();
    const { docListeners, winListeners } = stubDomListeners();
    try {
      const detach = session.attach();
      docListeners.get("visibilitychange")!();
      await flush();
      expect(engines[0].calls).toEqual(["syncNow"]);

      engines[0].calls.length = 0;
      winListeners.get("online")!();
      await flush();
      expect(engines[0].calls).toEqual(["syncNow"]);
      detach();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes when the engine reports a state change", async () => {
    // Carried defect (a). `armEngine`'s `onStateChanged` used to assign the closed-over
    // `engineState` and stop, so no subscriber ever learned a sync state moved — the
    // instant the provider's only path to the UI became `useSyncExternalStore`, the
    // Drive status row would have frozen with no syncing indicator, no elapsed time, no
    // error state. Driven through the injected `createEngine` port, which is the only
    // way to reach the callback `armEngine` builds without running a real sync cycle.
    let onStateChanged: SyncEngineDeps["onStateChanged"] | null = null;
    const stubEngine: SyncEngine = {
      async syncNow() {},
      notifyLocalChange() {},
      async resolveUseLocal() {},
      async resolveUseRemote() {},
      getState: () => ({ kind: "idle", lastSyncAt: null }),
      dispose() {},
    };
    const { session, auth, repo } = makeSession({
      createEngine: (deps: SyncEngineDeps) => {
        onStateChanged = deps.onStateChanged;
        return stubEngine;
      },
    });
    const book = emptyBook();
    await repo.save(book);
    session.setBook(book);
    const connecting = session.connect();
    await auth.tokenGate.settle(ok("token-1"));
    await connecting;
    let notified = 0;
    session.subscribe(() => {
      notified += 1;
    });
    onStateChanged!({ kind: "syncing", lastSyncAt: null });
    expect(notified).toBe(1);
    expect(session.getSnapshot().state).toEqual({ kind: "syncing", lastSyncAt: null });
  });

  it("syncNow, resolveUseLocal and resolveUseRemote each reach the live connection's engine", async () => {
    // A spy engine, not the real `createSyncEngine`: it isolates the one thing these
    // three methods actually promise — reaching `current.engine` — from the rest of a
    // real sync cycle. (`armEngine`'s own `onStateChanged` → `publish()` wiring has its
    // own test above.)
    const calls: string[] = [];
    const fakeEngine: SyncEngine = {
      async syncNow() {
        calls.push("syncNow");
      },
      notifyLocalChange() {},
      async resolveUseLocal() {
        calls.push("resolveUseLocal");
      },
      async resolveUseRemote() {
        calls.push("resolveUseRemote");
      },
      getState: () => ({ kind: "idle", lastSyncAt: null }),
      dispose() {},
    };
    const { session, auth, repo } = makeSession({ createEngine: () => fakeEngine });
    const book = emptyBook();
    await repo.save(book);
    session.setBook(book);
    const connecting = session.connect();
    await auth.tokenGate.settle(ok("token-1"));
    await connecting;
    await flush(); // let finalize's own fire-and-forget syncNow() land first
    calls.length = 0;
    session.syncNow();
    session.resolveUseLocal();
    session.resolveUseRemote();
    await flush();
    expect(calls).toEqual(["syncNow", "resolveUseLocal", "resolveUseRemote"]);
  });

  it("syncNow, resolveUseLocal and resolveUseRemote on a disconnected session do nothing", () => {
    const { session } = makeSession();
    expect(() => session.syncNow()).not.toThrow();
    expect(() => session.resolveUseLocal()).not.toThrow();
    expect(() => session.resolveUseRemote()).not.toThrow();
  });
});
