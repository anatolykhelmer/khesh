import {
  IDLE,
  afterTeardown,
  visibleError,
  type ConnectStage,
  type TeardownIntent,
} from "./pending-plan-rule";
import type { SyncState, SyncEngineDeps, SyncEngine } from "../../service/sync-engine";
import type { SyncStorePort } from "../../ports/sync-store";
import type { GoogleAuth } from "../../adapters/google-drive-sync";
import type { SyncMetaStore, SyncMeta } from "../../adapters/sync-meta-store";
import type { LedgerRepository } from "../../ports/ledger-repository";
import type { Book } from "../../kernel/types";
import type { Result } from "../../kernel/result";
import {
  applyFirstConnect,
  firstConnectOptions,
  inspectRemote,
  isChoiceOffered,
  type FirstConnectChoice,
  type LocalState,
} from "../../service/sync-connect";
import { errorMessage } from "../../service/error-messages";
import { holdsNoUserData } from "../../kernel/book-utils";

export type SyncActivity = {
  connecting: boolean;
  applying: boolean;
  disconnecting: boolean;
  erasing: boolean;
  /** Any of the four above. Derived in one place, never assigned. */
  blocking: boolean;
};

export type SyncSnapshot = {
  configured: boolean;
  connected: boolean;
  email: string | null;
  state: SyncState | null;
  stage: ConnectStage;
  activity: SyncActivity;
  lastError: string | null;
};

/** What one connection hands its store. Deliberately `DriveStoreDeps` minus its two
 * test-only optional fields, so `createDriveSyncStore` is assignable unchanged. */
export type ConnectionIO = {
  getToken: (interactive?: boolean) => Promise<Result<string>>;
  getFileId: () => string | null;
  onFileId: (id: string) => Promise<void>;
};

export type SyncSessionPorts = {
  clientId: string;
  createAuth: () => GoogleAuth;
  createStore: (io: ConnectionIO) => SyncStorePort;
  createEngine: (deps: SyncEngineDeps) => SyncEngine;
  metaStore: SyncMetaStore;
  getRepo: () => LedgerRepository;
  runExclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  announceBookChanged: (book: Book | null) => void;
  fetchAccountEmail: (
    getToken: (interactive?: boolean) => Promise<Result<string>>,
  ) => Promise<Result<string>>;
};

export interface SyncSession {
  getSnapshot(): SyncSnapshot;
  subscribe(listener: () => void): () => void;
  setBook(book: Book | null): void;
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  applyChoice(choice: FirstConnectChoice, onStarted?: () => void): Promise<void>;
  cancelConnect(): void;
  disconnect(): Promise<void>;
  beginErase(): void;
  endErase(): void;
  syncNow(): void;
  reauth(): Promise<void>;
  resolveUseLocal(): void;
  resolveUseRemote(): void;
  dispose(): void;
}

/** One Drive connection, as a value with an identity. Later tasks capture and check it;
 * it is not exported because every flow that needs one reaches it through the session's
 * own methods. */
type Connection = {
  readonly id: number;
  readonly auth: GoogleAuth;
  readonly store: SyncStorePort;
  engine: SyncEngine | null;
  fileId: string | null;
  released: boolean;
};

export function createSyncSession(ports: SyncSessionPorts): SyncSession {
  const listeners = new Set<() => void>();

  // The mutable truth. `snapshot` below is the cached, frozen view of it.
  let connected = false;
  let email: string | null = null;
  let engineState: SyncState | null = null;
  let stage: ConnectStage = IDLE;
  let lastError: string | null = null;
  let connecting = false;
  let applying = false;
  let disconnecting = false;
  let erasing = false;

  let current: Connection | null = null;
  let nextConnectionId = 1;
  let previousBook: Book | null | undefined = undefined;
  let book: Book | null = null;

  let snapshot: SyncSnapshot = buildSnapshot();

  /** Whether the operation that captured `conn` still speaks for this session. One
   * question with one name, replacing three generation counters compared at four sites.
   * Both halves matter: `conn !== current` catches a *different* connection having taken
   * over, `conn.released` catches this one having been ended with nothing put in its place. */
  function superseded(conn: Connection): boolean {
    return conn !== current || conn.released;
  }

  function openConnection(): Connection {
    const auth = ports.createAuth();
    // `io` closes over `conn`, never over session-level state — that is the whole of
    // BL-053: a teardown abandons this object, so `getFileId` keeps answering the id this
    // connection actually holds instead of the null a shared ref would have been given.
    // `conn` is declared *after* `io` but referenced only inside closures that cannot run
    // before it exists (nothing here calls them synchronously), so `store` can be built
    // from `io` and assigned once, in the object literal below, with no readonly-field
    // cast and no later mutation of a field the type declares immutable.
    const io: ConnectionIO = {
      getToken: (interactive = false) => conn.auth.getToken(interactive),
      getFileId: () => conn.fileId,
      onFileId: async (id: string) => {
        conn.fileId = id;
        await ports.metaStore.save({ fileId: id });
      },
    };
    const conn: Connection = {
      id: nextConnectionId,
      auth,
      store: ports.createStore(io),
      engine: null,
      fileId: null,
      released: false,
    };
    nextConnectionId += 1;
    current = conn;
    return conn;
  }

  /** Give `conn` an engine. One definition, because `finalize` and the resume path both
   * need exactly these deps and two copies is how they drift. */
  function armEngine(conn: Connection): void {
    conn.engine = ports.createEngine({
      repo: ports.getRepo(),
      store: conn.store,
      runExclusive: ports.runExclusive,
      onBookChanged: ports.announceBookChanged,
      onStateChanged: (next) => {
        engineState = next;
        if (next.kind === "idle" && next.lastSyncAt !== null) {
          void ports.metaStore.save({ lastSyncAt: next.lastSyncAt });
        }
      },
    });
  }

  /**
   * Let go of everything `conn` holds against Drive. Releasing and nothing else: it writes
   * no connection state and takes no view on why.
   *
   * Everything dangerous goes synchronously ahead of the await — a disposed engine is the
   * difference between "this tab may still write the old book to Drive" and "it may not",
   * and `revoke()` is a network round trip with no timeout of its own. Idempotent, so
   * running it against an already-released connection costs nothing.
   */
  async function releaseConnection(conn: Connection): Promise<void> {
    if (conn.released) return;
    conn.released = true;
    conn.engine?.dispose();
    conn.engine = null;
    if (current === conn) current = null;
    await conn.auth.revoke();
  }

  /** Teardowns the *user* asked for. A connect captures this at its true start and
   * compares after every await: the question is "did the user's own erase begin under
   * me?", which outlives the teardown itself — `performReset` erases the book after
   * `disconnect()` has resolved. `bookVanished` must never bump it, because the dropped-plan
   * notice asks the user for exactly the connect a bump would veto. */
  let userEnds = 0;

  function localState(): LocalState {
    return book === null ? "none" : holdsNoUserData(book) ? "empty" : "real";
  }

  async function runConnect(): Promise<void> {
    // `disconnecting`, not just `connecting`/`applying`: a `disconnect()` already under way
    // bumps `userEnds` synchronously, ahead of anything this function could capture — there
    // is no await between that bump and this line, so an `endsAtStart` snapshot taken here
    // would just re-read the already-bumped value and a same-value check on it could never
    // fire. Refusing to start at all while `disconnecting` is what actually keeps the user
    // from paying for an OAuth popup on a connect an erase has already overtaken (defect 2);
    // the check that used to sit after `openConnection()`, comparing `userEnds` against a
    // baseline captured one synchronous line above it, could not have done that job.
    if (connecting || applying || disconnecting) return;
    connecting = true;
    lastError = null;
    // The notice asked for this tap and the button beside it is already disabled, so the
    // notice goes now rather than when the connect lands.
    stage = IDLE;
    publish();
    const endsAtStart = userEnds;
    const conn = openConnection();
    try {
      const token = await conn.auth.getToken(true);
      if (superseded(conn) || userEnds !== endsAtStart) return;
      if (!token.ok) {
        lastError = errorMessage(token.error.code);
        return;
      }
      const inspection = await inspectRemote(conn.store);
      if (superseded(conn) || userEnds !== endsAtStart) return;
      if (!inspection.ok) {
        lastError = errorMessage(inspection.error.code);
        return;
      }
      const seenLocal = localState();
      const plan = firstConnectOptions(seenLocal, inspection.value);
      if (plan.kind === "apply") {
        await applyAndFinalize(conn, plan.choice, endsAtStart);
        return;
      }
      stage = { kind: "choosing", inspection: inspection.value, plan, plannedFor: seenLocal };
    } finally {
      connecting = false;
      publish();
    }
  }

  async function teardown(intent: TeardownIntent): Promise<void> {
    if (intent.cause === "userAction") userEnds += 1;
    const conn = current;
    disconnecting = true;
    publish();
    try {
      if (conn) await releaseConnection(conn);
      await ports.metaStore.save({ connected: false, accountEmail: null, lastSyncAt: null });
      connected = false;
      email = null;
      engineState = null;
      stage = afterTeardown(stage, intent);
      // `userAction` only. The flow the user ended can leave an error belonging to a screen
      // they are leaving. Not on the `bookVanished` arm: there the same clear swallowed the
      // sign-in error of a Connect made *during* the teardown window, which is the "Connect
      // looks like it did nothing" BL-050 exists to remove.
      if (intent.cause === "userAction") lastError = null;
    } finally {
      disconnecting = false;
      publish();
    }
  }

  // --- Forward reference, ahead of its own task. -----------------------------------
  // `runConnect`'s "apply" branch (above) needs somewhere to go the moment a plan needs no
  // choice screen, and three of this task's own tests reach `connected: true` only through
  // it (`connectedSession()`'s empty-local/empty-remote case is exactly the one combination
  // `firstConnectOptions` answers with `{kind: "apply"}`). The plan assigns this pair to
  // Task 3, which is the one that owns the rollback tests below — that is why the
  // post-`metaStore.save` check in `finalize` is here already: leaving it out would make
  // this function *not* what Task 3 is about to test, and a second, diverging definition
  // three commits later is how the two drift. Task 3 should find both already matching
  // what it needs and spend its own diff on tests. (Task 3 did end up giving this a second
  // caller of its own, below: `applyChoice`, minimally, for its own "erase lands inside the
  // apply itself" test — so `runConnect`'s auto-apply branch is no longer the only route in.)
  /**
   * Turn a decided `{kind: "apply"}` plan into a live connection: run the choice, then
   * claim the connection if nothing has overtaken it.
   */
  async function applyAndFinalize(
    conn: Connection,
    choice: FirstConnectChoice,
    endsAtStart: number,
  ): Promise<void> {
    const applied = await applyFirstConnect(choice, {
      repo: ports.getRepo(),
      store: conn.store,
      runExclusive: ports.runExclusive,
    });
    if (!applied.ok) {
      // A doomed apply says nothing: the user asked for the thing that made it moot, and
      // every screen this can happen on is one they are leaving.
      if (superseded(conn) || userEnds !== endsAtStart) return;
      lastError = errorMessage(applied.error.code);
      return;
    }
    if (superseded(conn) || userEnds !== endsAtStart) {
      await releaseConnection(conn);
      return;
    }
    ports.announceBookChanged(applied.value);
    await finalize(conn, endsAtStart);
  }

  /**
   * Claim the connection: persist it, show it, arm the engine.
   *
   * **The check after the write is the point.** `SyncMetaStore.save` is a non-atomic
   * read-modify-write, so this write and a concurrent teardown's are unordered against each
   * other and no check placed before this line can decide the outcome. Checking again after
   * it, and undoing, makes the final state the same in both landing orders — which is what
   * "an erase the user asked for outranks a connect started under it" has to mean if it is
   * to be a property of the code rather than of the timing.
   */
  async function finalize(conn: Connection, endsAtStart: number): Promise<void> {
    const emailResult = await ports.fetchAccountEmail((interactive = false) =>
      conn.auth.getToken(interactive),
    );
    if (superseded(conn) || userEnds !== endsAtStart) {
      await releaseConnection(conn);
      return;
    }
    // BL-054 ("an account it cannot name") is closed above this line, not by refusing here.
    // The old bug was `authRef.current!` throwing when a shared ref had already gone null
    // under a torn-down connection; `conn.auth` is never shared and never null by
    // construction, so that crash cannot happen, and the ordinary case it crashed inside —
    // an email fetch failing because a concurrent teardown killed the auth it reads through
    // — is exactly what the supersession check above already catches, before this line runs.
    // What reaches here with `emailResult.ok === false` is the remaining case: a transient
    // failure of the userinfo endpoint, nothing else wrong. `applyFirstConnect` has already
    // written the user's book to Drive by this point, so refusing here would tear down a
    // working connection and an already-completed write over a network hiccup, and show the
    // user an error about fetching an email instead of about their data. `accountEmail` is
    // simply `null` in that case — the "no account name" UI state a working, still-nameless
    // connection is supposed to render.
    const accountEmail = emailResult.ok ? emailResult.value : null;
    await ports.metaStore.save({ connected: true, accountEmail });
    connected = true;
    email = accountEmail;
    stage = IDLE;
    armEngine(conn);
    publish();
    // The rollback. Everything above is what a teardown would otherwise have to undo, and
    // could not, because it had already answered "proceed" and gone home.
    if (superseded(conn) || userEnds !== endsAtStart) {
      // Which teardown to record matters. `userAction` would bump `userEnds` and veto the
      // Connect the drop notice is about to ask for, so a supersession that was not the
      // user's is rolled back as what it was.
      await teardown(
        userEnds !== endsAtStart
          ? { cause: "userAction" }
          : { cause: "bookVanished", startedFrom: stage },
      );
      return;
    }
    void conn.engine?.syncNow();
  }

  /** The one place `blocking` is computed. Assigning it anywhere else is how a fifth
   * activity gets added and forgotten, which is BL-055's shape one field lower down. */
  function buildSnapshot(): SyncSnapshot {
    return {
      configured: ports.clientId !== "",
      connected,
      email,
      state: engineState,
      stage,
      activity: {
        connecting,
        applying,
        disconnecting,
        erasing,
        blocking: connecting || applying || disconnecting || erasing,
      },
      // The notice and a red error may not share the collapsed Connect row: a dropped plan
      // needs one tap on Connect, and the neutral sentence is the whole explanation.
      // Applied here rather than in the provider's render, which is where it used to live —
      // there is no longer a frame between deriving the notice and writing the state.
      lastError: visibleError(stage, lastError),
    };
  }

  /** Rebuild the cached snapshot and notify. `useSyncExternalStore` compares snapshots by
   * identity and loops forever on a `getSnapshot` that allocates per call, so the cache is
   * a correctness requirement and not an optimisation — and one that cannot fail in
   * `environment: "node"`, which is why it lives in exactly one function. */
  function publish(): void {
    snapshot = buildSnapshot();
    for (const listener of listeners) listener();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    beginErase() {
      if (erasing) return;
      erasing = true;
      publish();
    },
    endErase() {
      if (!erasing) return;
      erasing = false;
      publish();
    },
    setBook(nextBook) {
      book = nextBook;
    },
    connect: runConnect,
    async reconnect() {
      if (connecting || applying) return;
      // One operation with one capture at its true start. The provider's old `reconnect`
      // had to read the erase counter *before* `forgetFile()` and thread it into
      // `connect()`, because that IndexedDB write was a window an erase could begin in and
      // a read at the top of `connect` would have seen the bumped value and waved it
      // through. Inside the session there is no gap to thread across.
      if (current) current.fileId = null;
      await ports.metaStore.save({ fileId: null });
      await runConnect();
    },
    async disconnect() {
      await teardown({ cause: "userAction" });
    },
    // A user tap may open the Google popup, which the silent path cannot. Task 2 needs this
    // much of Task 6's `reauth` for its own "disconnect must not wait on a hanging token
    // fetch" test; the rest of that task's surface (`syncNow`, `resolveUseLocal`,
    // `resolveUseRemote`, `dispose`, the port-failure sweep) stays stubbed below.
    async reauth() {
      const conn = current;
      if (!conn) return;
      const token = await conn.auth.getToken(true);
      if (superseded(conn) || !token.ok) return;
      await conn.engine?.syncNow();
    },
    async applyChoice(choice, onStarted) {
      // Act only on a choice the live plan actually offers. A tap carries a value rendered
      // from some earlier plan, and between the render and the handler the plan can have
      // been dropped as stale, cancelled, or replaced by a second Connect. The screens
      // disable these buttons too; this is the half that does not depend on every future
      // screen remembering to.
      const live = stage.kind === "choosing" ? stage : null;
      if (!isChoiceOffered(live?.plan ?? null, choice)) return;
      if (connecting || applying) return;
      const conn = current;
      if (!conn) return;
      applying = true;
      // Past both guards, so this choice and no other is what is now running. Announced
      // here rather than assumed by the caller: a tap the guards turn away would otherwise
      // leave the screen's "Working…" on the refused button while the accepted one runs.
      onStarted?.();
      lastError = null;
      publish();
      const endsAtStart = userEnds;
      try {
        await applyAndFinalize(conn, choice, endsAtStart);
      } finally {
        applying = false;
        publish();
      }
    },
    cancelConnect() {
      // Ends the first-connect flow *as the screen shows it* and nothing more. Not a
      // cancellation: a connect in flight keeps running. `disconnect()` is what lets go of
      // a connection — and unlike in the old provider, it genuinely does, because a connect
      // that finishes afterwards finds itself superseded and rolls back.
      if (stage.kind === "idle") return;
      stage = IDLE;
      publish();
    },
    // Every remaining method is added by Tasks 6 and 8. Until then they must exist and
    // be typed, so the interface compiles:
    syncNow() {},
    resolveUseLocal() {},
    resolveUseRemote() {},
    dispose() {},
  };
}
