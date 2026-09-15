/**
 * No method on this interface rejects. `applyChoice` and `connect` are invoked as
 * `void sync.applyChoice(…)` from click handlers in an app with no error boundary, so a
 * throw reaching the caller is an unhandled rejection and nothing more. Port failures that
 * the user can act on become `lastError`; the rest are swallowed deliberately.
 */
import {
  IDLE,
  afterLocalStateChange,
  afterTeardown,
  visibleError,
  type ConnectStage,
  type TeardownIntent,
} from "./pending-plan-rule";
import { shouldTearDown } from "./teardown-rule";
import { syncSignal } from "./sync-signal";
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
  pickerConfigured: boolean;
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
  /** VITE_GOOGLE_PICKER_API_KEY is present. Without it, joinShared is a no-op — there is
   * no way to open the Picker at all. */
  pickerConfigured: boolean;
  /** Opens the Google Picker with the given (already-fetched) access token and resolves
   * to the picked file's id, or null if the dialog was closed without picking one. */
  pickFile: (accessToken: string) => Promise<string | null>;
};

export interface SyncSession {
  getSnapshot(): SyncSnapshot;
  subscribe(listener: () => void): () => void;
  /** Wire this session to the page — local commits, tab visibility, connectivity — and
   * return the detach. Separate from construction and from `dispose()` because the session
   * outlives both ends of a React effect; see the implementation's own note. */
  attach(): () => void;
  setBook(book: Book | null): void;
  connect(): Promise<void>;
  joinShared(): Promise<void>;
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
  readonly recordFileId: (id: string) => Promise<void>;
  released: boolean;
};

/** Never rejects, and never silent. A throw reaching a caller is an unhandled rejection
 * (see the module doc); a throw nobody records is an undebuggable one. */
function swallow(where: string, error: unknown): void {
  console.error(`[sync-session] ${where}`, error);
}

export function createSyncSession(ports: SyncSessionPorts): SyncSession {
  const listeners = new Set<() => void>();

  /**
   * Local commits nudge the engine; window events trigger opportunistic syncs. In the
   * session rather than in a provider effect, because `current.engine` is the thing they
   * are about and the provider has no reference to it.
   *
   * **Wired here and not at construction, torn down by the returned detach and not by
   * `dispose()`.** The session is created once, in a ref, and that ref survives React's
   * StrictMode dev cycle — mount is setup → cleanup → setup — while `dispose()` is called
   * from an effect cleanup. So anything wired at construction was gone for good after the
   * first dev remount: `syncSignal` unsubscribed, which is the *only* path from a local
   * commit to `engine.notifyLocalChange()`, and both window listeners removed. Production
   * never saw it — the provider is at the root and never unmounts — but the one live
   * verification this seam gets is a human running dev against real Google, which is
   * precisely the build it broke. The lifetime of these three is the effect's, so the
   * effect is what owns them.
   *
   * Named handlers, not inline closures, so the detach removes exactly what this added —
   * an unremoved `visibilitychange` listener keeps a released connection's closure alive
   * and fires `syncNow()` into it.
   *
   * `typeof document`/`typeof window` guards because this module runs under
   * `environment: "node"`, where neither exists. They are load-bearing: without them every
   * session test that attaches throws.
   */
  function attach(): () => void {
    const unsubscribeSignal = syncSignal.subscribe(() => current?.engine?.notifyLocalChange());
    const handleVisibilityChange = (): void => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void current?.engine?.syncNow();
      }
    };
    const handleOnline = (): void => {
      void current?.engine?.syncNow();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", handleOnline);
    }
    return () => {
      unsubscribeSignal();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("online", handleOnline);
      }
    };
  }

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
  /** The resume question has been *settled* — adopted, or answered "there is nothing
   * stored to adopt". Not "a load was started": see `resumeStoredConnection`. */
  let resumeSettled = false;
  /** A resume load is in flight. What actually stops a second `setBook` racing the first. */
  let resuming = false;

  let snapshot: SyncSnapshot = buildSnapshot();

  /** Whether the operation that captured `conn` still speaks for this session. One
   * question with one name, replacing three generation counters compared at four sites.
   *
   * The two halves ask the same question from opposite ends: `conn !== current` is "someone
   * else took over", `conn.released` is "this one was ended, with or without a replacement".
   * Now that `openConnection` is an exclusive claim they can no longer disagree — the only
   * way to stop being `current` is to be released first, and the only way to be released is
   * to stop being `current` — so the disjunction is what *states* that invariant and catches
   * a future writer breaking it, not two independent cases. Every caller is a task deciding
   * whether to keep acting, so answering "yes" for either reason is the same answer. */
  function superseded(conn: Connection): boolean {
    return conn !== current || conn.released;
  }

  /**
   * Open a connection and make it *the* connection.
   *
   * **An exclusive claim on `current`, not an assignment over it.** Releasing whatever this
   * one displaces is what gives `superseded()` its meaning: asking "am I still current?"
   * decides nothing unless losing `current` also *ends* the connection that lost it.
   * Without the release the displaced object kept everything it could still act through —
   * an engine still writing this tab's book to the old Drive file and still reporting states
   * into the snapshot, and a token nothing ever revoked. Three routes reached it: a retry
   * after a failed `getToken`/`inspectRemote`, a Connect following `cancelConnect` (which
   * deliberately releases nothing), and a stored resume landing beside a connect.
   *
   * `releaseConnection` does all of its dangerous work — `released`, `engine.dispose()`,
   * `current = null` — synchronously ahead of its own await, so every bit of it lands before
   * the line at the bottom installs the new connection; only `revoke()` is left in flight,
   * and that touches no session state. It is idempotent, which is what makes the
   * `superseded` early-returns free to release the same connection again a moment later.
   */
  function openConnection(): Connection {
    const displaced = current;
    if (displaced) {
      void releaseConnection(displaced).catch((error: unknown) =>
        swallow("openConnection: release", error),
      );
    }
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
        // In memory unconditionally: this is the id the write running *right now* is
        // using, and `getFileId` has to keep answering it even after a teardown — BL-053
        // again, from the write's own side.
        conn.fileId = id;
        // Into the shared record only while this connection still speaks for the session.
        // `SyncMeta.fileId` is one slot for the whole tab, so an abandoned connect that
        // discovers or creates a file would otherwise persist its id over the live
        // connection's, and the next boot would resume at whichever wrote last.
        if (superseded(conn)) return;
        await ports.metaStore.save({ fileId: id });
      },
    };
    const conn: Connection = {
      id: nextConnectionId,
      auth,
      store: ports.createStore(io),
      engine: null,
      fileId: null,
      recordFileId: io.onFileId,
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
        // An engine whose connection has been displaced can still be finishing a cycle —
        // `dispose()` stops it taking new work, not the one already running. It no longer
        // speaks for the session, so it may neither paint the status row over the live
        // connection's nor write `lastSyncAt` into the shared record.
        if (superseded(conn)) return;
        engineState = next;
        publish();
        if (next.kind === "idle" && next.lastSyncAt !== null) {
          void ports.metaStore
            .save({ lastSyncAt: next.lastSyncAt })
            .catch((error: unknown) => swallow("onStateChanged", error));
        }
      },
    });
  }

  /**
   * Let go of everything `conn` can still *act* through: its engine, its standing as the
   * session's current connection, its token. Releasing and nothing else: it writes no
   * connection state and takes no view on why.
   *
   * Everything dangerous goes synchronously ahead of the await — a disposed engine is the
   * difference between "this tab may still write the old book to Drive" and "it may not",
   * and `revoke()` is a network round trip with no timeout of its own. Idempotent, so
   * running it against an already-released connection costs nothing.
   *
   * **Two file ids are deliberately left alone**, and the old `forgetFile()` cleared both.
   * `conn.fileId` stays because that is BL-053 itself: a write that grabbed this store
   * before the teardown must keep reading the id this connection actually holds, or it
   * takes the create-a-new-file path and duplicates the user's book. The *persisted* id in
   * `SyncMeta` stays for a plainer reason — it is an address, not a claim of liveness.
   * `connected: false`, written by `teardown` in the same record, is what says the
   * connection is over, and `resumeStoredConnection` adopts nothing without it. Keeping the
   * address means the next connect addresses the same Drive file directly instead of
   * re-deriving it from a name search.
   *
   * The one flow that wants the address gone — `reconnect`, recovering from
   * `SYNC_FILE_MISSING` — clears the *persisted* one and then releases the connection
   * through this function like everyone else. It does not empty `conn.fileId`, and nothing
   * may: that field is what a doomed in-flight write reads to decide whether to duplicate
   * the user's book, so the connection is abandoned holding its id rather than kept holding
   * none.
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

  /**
   * A plan is decided once, from the local state at the moment the remote was inspected —
   * that is what stops the choices shifting under the user's finger. The book can still
   * move underneath it, and then the plan describes a local side that no longer exists.
   *
   * The third argument must be `applying` and nothing else. It marks the one window in
   * which the local state moves *because of the user's own choice*: pass `false` and a
   * successful `useRemote` announces "the book changed, connect again" over its own
   * success, and pass anything broader — `blocking`, an import in flight — and the drop
   * stays suppressed while the book really is moving underneath, which is the hole
   * `plannedFor` exists to close. This is why `activity` is a record and not one boolean.
   */
  function applyStalenessGate(): void {
    const next = afterLocalStateChange(stage, localState(), applying);
    // While the plan is dropped there is no error in state: the neutral sentence is the
    // whole explanation, and the error that would sit under it is a failed apply from the
    // plan being dropped, which is now moot.
    //
    // Keyed on the resulting stage being `dropped`, and placed *above* the early return —
    // not on this call having been the thing that dropped it. `visibleError` only hides the
    // error; the clear is what stops it coming back the moment something moves the stage
    // off `dropped` without touching it. A `DROPPED` written elsewhere reaches this
    // function as a no-op transition (`afterLocalStateChange` passes a non-`choosing` stage
    // straight through), so an early return above the clear is exactly how the old provider
    // left the error set — the arrangement its own doc then claimed it did not have.
    if (next.kind === "dropped") lastError = null;
    // No publish on this branch even when the clear above fired: `visibleError` already
    // answered `null` for a dropped stage, so every field of the snapshot is unchanged.
    if (next === stage) return;
    stage = next;
    publish();
  }

  /**
   * Adopt a connection this tab already had, the first time the book becomes available to
   * check it against.
   *
   * **Two flags, because "a load is running" and "the question is answered" are different
   * facts and one boolean conflated them.** `resuming` is what stops a second `setBook` —
   * same book, a re-render, one landing before the load resolves — starting a second load
   * racing the first. `resumeSettled` is what stops the *next* `setBook` asking again, and
   * it is set only once this has an answer it will not revise: a connection adopted, or a
   * record that says there is nothing to adopt. Latching on entry instead, as this did,
   * meant a load that threw (a transient IDB error), a book that vanished under it, or a
   * refusal below left the stored connection unadopted until the tab was reloaded — a
   * latch on "asked", asserted as a latch on "answered".
   *
   * Everything below the load is a *commitment*: it arms an engine at the user's real Drive
   * file. `runConnect` is refused outright while `erasing` because screens cannot be trusted
   * to hold that line, and this is the other path that commits, so it asks the same
   * question — otherwise a stored resume landing inside `performReset`'s `resetAll()` window
   * arms an engine at the real file while the local book is being erased: BL-040's window,
   * reopened through the one path this session adds.
   *
   * **A refusal is not an answer**, so `resumeSettled` stays false and the next `setBook`
   * with a book asks again. What makes that retry safe is not anything here — it is that
   * `performReset` now runs its `disconnect()` unconditionally, so by the time the wizard's
   * fresh seed arrives the record reads `connected: false` and the branch above settles
   * quietly. This comment used to assert that outcome while `performReset` still gated its
   * teardown on a `connected`/`pendingInspection` snapshot that is false for exactly the tab
   * this load belongs to; nothing wrote `connected: false` on that path, and the retry
   * adopted the old Drive file onto the new book. The guarantee lives in `reset-flow.ts`,
   * which carries the walk-through and the test, and the one residual it names — a teardown
   * whose meta write was swallowed — reaches this retry unchanged.
   */
  function resumeStoredConnection(): void {
    if (resumeSettled || resuming || connected || book === null || ports.clientId === "") return;
    resuming = true;
    void ports.metaStore.load().then((meta) => {
      // `shouldTearDown` cannot see the window this load is in flight for: it only tears a
      // connection down once one exists (`connected` or a live `pendingInspection`), and
      // neither holds yet while this callback is still pending — so a book that vanishes
      // (or a different one that arrives) during the load passes straight through it, now
      // and on every `setBook` after, since `previous` is already what `next` was by then.
      // Rechecking `book` here, against the value as it stands *when this resolves* rather
      // than when the load started, is what catches it instead.
      if (book === null) return;
      // Settled either way: an unconnected record has nothing to adopt, and a session that
      // became connected while this was in flight has already answered the question.
      if (!meta.connected || connected) {
        resumeSettled = true;
        return;
      }
      // Refused, not answered. A connect in flight is about to claim `current` itself, and
      // adopting here would displace it mid-flight; an erase or a teardown is the state
      // this may not commit into at all.
      if (erasing || disconnecting || connecting) return;
      resumeSettled = true;
      const conn = openConnection();
      conn.fileId = meta.fileId;
      connected = true;
      email = meta.accountEmail;
      engineState = { kind: "idle", lastSyncAt: meta.lastSyncAt };
      // Being connected retires any first-connect state by definition: the plan describes a
      // connection that is now made, and the notice asks for a tap on a Connect row this
      // session is about to stop rendering.
      stage = IDLE;
      armEngine(conn);
      publish();
      conn.engine?.syncNow().catch((error: unknown) => swallow("resumeStoredConnection", error));
    }).catch((error: unknown) => swallow("resumeStoredConnection", error))
      // A load that threw leaves nothing settled, so this has to come back off on the
      // failure path too, or one transient IDB error is the same permanent latch by
      // another name.
      //
      // **It clears the flag; it does not retry.** Nothing re-invokes on the failure path,
      // so a thrown `load()` defers the whole question to the next `setBook` — and at boot
      // there may not be one: `SyncProvider`'s effect fires on `book` identity, so a tab
      // whose only book arrived before the throw sits unresumed until something else moves
      // the book or the page reloads. Re-invoking from here instead would loop against a
      // permanently broken IndexedDB with no ceiling, which is why it does not; stating the
      // gap is the honest half of that choice.
      .finally(() => {
        resuming = false;
      });
  }

  /**
   * `recovering` says this is `reconnect()` rebuilding the connection the session already
   * has, rather than a fresh Connect or Join. It exists for one guard, four lines down —
   * see there. Defaulted, so the two ordinary call sites read as they always did.
   */
  async function runConnect(usePicker: boolean, recovering = false): Promise<void> {
    // `disconnecting` and `erasing`, not just `connecting`/`applying`. A `disconnect()`
    // already under way bumps `userEnds` synchronously, ahead of anything this function
    // could capture *when `connect()` is the caller* — there is no await between that bump
    // and this line on that route, so an `endsAtStart` snapshot taken here would re-read
    // the already-bumped value and a same-value check on it could never fire. Refusing to
    // start at all while `disconnecting` is what actually keeps the user from paying for an
    // OAuth popup on a connect an erase has already overtaken (defect 2).
    //
    // That "no await before this line" argument is about `connect()` alone. `reconnect()`
    // awaits a `metaStore.save` before it calls this function, so a whole teardown can
    // start *and finish* inside its window and be gone by the time this guard runs — which
    // is why `reconnect` captures `userEnds` at its own true start and bails on the far
    // side of that save, rather than leaving the question to this line.
    //
    // `erasing` is here so the refusal is structural. It is the reason the erase became
    // session state at all: the screens that offer Connect read it back as
    // `activity.blocking`, and this is the half that does not depend on every future screen
    // remembering to. `resumeStoredConnection` asks the same question for the same reason.
    if (connecting || applying || disconnecting || erasing) return;
    // A join while already connected would open a second connection, run the Picker, and
    // persist a picked file id into a meta record that still reads `connected: true` — an
    // abandoned join followed by a reload could then resume onto a different family
    // member's book with no choice ever applied. Unreachable from today's UI (no Join
    // button exists before Task 6, and it will only render while disconnected), but this
    // function already guards defensively rather than trusting its callers, and this is
    // that same discipline applied to the one new way in.
    //
    // **`recovering` is the one exception, and without it the joined-book Reconnect below
    // is inert.** `reconnect()` deliberately writes no `connected` — the user is
    // reconnecting, not disconnecting, and the row it is tapped from lives in the connected
    // view — so `connected` is still `true` when it calls in here, and a bare
    // `usePicker && connected` turns the Picker recovery away without a trace. The hazard
    // above is about a *second, fresh* connection opened beside a live one; a recovery is
    // the same connection being rebuilt, and it has already released its predecessor two
    // lines before this call. The residual it does still carry — an abandoned pick leaving
    // a foreign file id under a record that reads `connected: true` — is the one the
    // ordinary name-search reconnect has always carried, and the resume it feeds runs a
    // normal engine cycle with its own conflict resolution rather than a blind overwrite.
    if (usePicker && connected && !recovering) return;
    connecting = true;
    lastError = null;
    // The notice asked for this tap and the button beside it is already disabled, so the
    // notice goes now rather than when the connect lands.
    stage = IDLE;
    publish();
    try {
      const endsAtStart = userEnds;
      const conn = openConnection();
      const token = await conn.auth.getToken(true);
      // Doomed, so let go of it — the same answer `applyAndFinalize` and `finalize` give
      // further down this flow, and for the same reason: a bare `return` leaves a connection
      // no later teardown can find, because it is no longer `current` and nothing else holds
      // a reference.
      //
      // **This call cannot be observed to do anything today, and that is the proof the fix
      // above is at the right layer, not an argument for deleting it.** Both halves of the
      // condition now imply the connection is already released: `superseded` because
      // `openConnection` releases what it displaces, and a `userEnds` bump because only a
      // `userAction` teardown makes one, in the same synchronous step as releasing whatever
      // was `current`. So `releaseConnection` short-circuits on `conn.released` every time —
      // mutating this line away turns no test red, and no test is written to pretend
      // otherwise. It stays because the alternative is a bare `return` whose safety rests
      // entirely on that invariant holding elsewhere, and this is the site that would leak
      // if it ever stopped.
      if (superseded(conn) || userEnds !== endsAtStart) {
        await releaseConnection(conn);
        return;
      }
      // A plain failure, not a supersession: nothing took over, so this connection is still
      // the session's, and it is inert — no engine, no plan, nothing driving it. It is let
      // go of by whatever comes next, which is either the retry's own claim on `current` or
      // a teardown. Releasing it here instead would revoke a token the user may be one tap
      // from reusing, and would make the claim in `openConnection` unobservable on the one
      // route that most needs it.
      if (!token.ok) {
        lastError = errorMessage(token.error.code);
        return;
      }
      if (usePicker) {
        // The real adapter's script-load can reject, unlike the other ports this function
        // awaits. Caught here, specifically, rather than falling through to the outer
        // `catch` below: that one only logs to `console.error` (see `swallow`'s own doc),
        // so a rejected pickFile would look identical to a plain cancel to the user, right
        // after they already went through an OAuth popup. Every other failure path in this
        // function — `!token.ok`, `!inspection.ok` — sets `lastError`; this is that same
        // treatment for the one port call that can throw instead of resolving to a Result.
        //
        // Its own code rather than `SYNC_STORE_FAILED`: nothing has been asked of Drive
        // yet at this point, so "Could not reach Google Drive" would name the wrong thing
        // — what failed is the picker widget itself (its script load, or the timeout it
        // now carries).
        let pickedFileId: string | null;
        try {
          pickedFileId = await ports.pickFile(token.value);
        } catch {
          if (superseded(conn) || userEnds !== endsAtStart) {
            await releaseConnection(conn);
            return;
          }
          lastError = errorMessage("SYNC_PICKER_FAILED");
          return;
        }
        if (superseded(conn) || userEnds !== endsAtStart) {
          await releaseConnection(conn);
          return;
        }
        // Cancelled: no-op, same shape as the plain-failure branch above — nothing took
        // over, so the connection is left inert for whatever comes next.
        if (pickedFileId === null) return;
        await conn.recordFileId(pickedFileId);
        if (superseded(conn) || userEnds !== endsAtStart) {
          await releaseConnection(conn);
          return;
        }
      }
      const inspection = await inspectRemote(conn.store);
      if (superseded(conn) || userEnds !== endsAtStart) {
        await releaseConnection(conn);
        return;
      }
      if (!inspection.ok) {
        lastError = errorMessage(inspection.error.code);
        return;
      }
      const seenLocal = localState();
      const plan = firstConnectOptions(seenLocal, inspection.value);
      if (plan.kind === "apply") {
        await applyAndFinalize(conn, plan.choice, endsAtStart, usePicker);
        return;
      }
      stage = {
        kind: "choosing",
        inspection: inspection.value,
        plan,
        plannedFor: seenLocal,
        viaPicker: usePicker,
      };
    } catch (error) {
      swallow("connect", error);
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
      // Both awaits below are round trips that can reject — `revoke()` over the network,
      // `save` into IndexedDB — and neither may strand the tail. A teardown that gave up at
      // its first statement left the app showing "Synced" over a released connection *and*
      // a persisted record still saying connected, which the next boot resumes: a
      // connection whose token was never revoked. Each failure is recorded and the tail
      // runs regardless, which is what makes "the snapshot settles into a coherent state"
      // a property of this function rather than of which port happened to work.
      if (conn) {
        try {
          await releaseConnection(conn);
        } catch (error) {
          swallow("teardown: release", error);
        }
      }
      try {
        // `fileId` is deliberately not cleared here; see `releaseConnection`'s own note.
        await ports.metaStore.save({ connected: false, accountEmail: null, lastSyncAt: null });
      } catch (error) {
        swallow("teardown: meta", error);
      }
      connected = false;
      email = null;
      engineState = null;
      stage = afterTeardown(stage, intent);
      // Two clears, one rule each.
      //
      // `userAction`: the flow the user ended can leave an error belonging to a screen they
      // are leaving.
      //
      // A resulting stage of `dropped`: the same rule `applyStalenessGate` applies, and the
      // reason it has to be applied here too is that this is the other place `DROPPED` gets
      // written.
      //
      // Keyed on the *outcome*, not on the cause, because the two answer different
      // questions. The cause says why this teardown started; the clear is about what is on
      // screen when it ends, and `afterTeardown` is what decides that. It says `dropped`
      // only when this teardown actually wrote the notice — exactly the stage where the
      // notice is the whole explanation and a red line beneath it would break the one
      // meaning colour carries in this app (`components.css`). Every other answer is a
      // stage that *shows* errors: `idle` is the plain Connect row, where a failure is the
      // only thing the user has to go on. A clear keyed on `cause === "bookVanished"` wiped
      // it there too, which is the "Connect looks like it did nothing" BL-050 removes.
      //
      // The two keys diverge only when something moves `stage` off `intent.startedFrom`
      // inside this function's awaits, so `afterTeardown` no longer recognises the plan and
      // answers `idle`. One writer can: `cancelConnect()`, which has no guard at all.
      // `runConnect` — so both `connect()` and `reconnect()` — is refused outright while
      // `disconnecting`, and `applyChoice` gets no further than its `current` check, since
      // `releaseConnection` nulls `current` synchronously ahead of every await above. Note
      // that second one is closed by that ordering and not by a guard of its own: narrow,
      // and narrow because of code elsewhere, which is the reason to key this line on the
      // outcome it is actually about rather than on a cause that merely correlates with it.
      if (intent.cause === "userAction" || stage.kind === "dropped") lastError = null;
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
    viaPicker: boolean,
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
    await finalize(conn, endsAtStart, viaPicker);
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
  async function finalize(
    conn: Connection,
    endsAtStart: number,
    viaPicker: boolean,
  ): Promise<void> {
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
    // `joinedViaPicker` rides along with the write that claims the connection, so the two
    // can never disagree: a record saying connected always says *how*. `reconnect()` reads
    // it back to recover a joined book through the Picker instead of through a name search
    // that is scoped to the user's own files and would find nothing.
    await ports.metaStore.save({ connected: true, accountEmail, joinedViaPicker: viaPicker });
    // The one write below that the rollback's own `teardown` cannot undo for itself.
    // `connected`, `email` and `engineState` it overwrites unconditionally; `stage` it
    // *reads* — `afterTeardown` answers from the stage it finds — so the `IDLE` on the next
    // line would be the answer, and a `dropped` a concurrent teardown had already written
    // would be silently swallowed by this claim. That is BL-050 reopened through the
    // rollback: the user lands on onboarding with no notice, and Connect looks like it did
    // nothing. Captured here and put back below.
    const stageBeforeClaim = stage;
    connected = true;
    email = accountEmail;
    stage = IDLE;
    publish();
    // The rollback. Everything above is what a teardown would otherwise have to undo, and
    // could not, because it had already answered "proceed" and gone home.
    if (superseded(conn) || userEnds !== endsAtStart) {
      stage = stageBeforeClaim;
      // Which teardown to record matters. `userAction` would bump `userEnds` and veto the
      // Connect the drop notice is about to ask for, so a supersession that was not the
      // user's is rolled back as what it was. Restoring `stage` above is what lets
      // `afterTeardown` answer the question it is actually being asked: `dropped` passes
      // through unchanged, and a `choosing` this claim clobbered before any teardown had
      // landed still matches `startedFrom` by identity and becomes `dropped` here.
      await teardown(
        userEnds !== endsAtStart
          ? { cause: "userAction" }
          : { cause: "bookVanished", startedFrom: stageBeforeClaim },
      );
      return;
    }
    // Armed only past the rollback. On that path `releaseConnection` has already nulled
    // `conn.engine` and dropped `conn` as `current`, so the teardown above releases
    // whatever is current — no longer `conn` — and an engine created before the check would
    // be one nothing ever disposes. Measured as 1 created, 0 disposed.
    armEngine(conn);
    conn.engine?.syncNow().catch((error: unknown) => swallow("finalize", error));
  }

  /** The one place `blocking` is computed. Assigning it anywhere else is how a fifth
   * activity gets added and forgotten, which is BL-055's shape one field lower down. */
  function buildSnapshot(): SyncSnapshot {
    return {
      configured: ports.clientId !== "",
      pickerConfigured: ports.pickerConfigured,
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
    attach,
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
    setBook(next) {
      const previous = previousBook;
      previousBook = next;
      book = next;
      const pendingInspection = stage.kind === "choosing" ? stage.inspection : null;
      if (shouldTearDown(previous, next, { connected, pendingInspection })) {
        // The intent carries *this* stage, so the plan the teardown announces as dropped is
        // the one it was called about rather than whichever is current when its awaits land.
        const startedFrom = stage;
        // Nothing awaits this, so it needs a catch — and the module's rule is that no catch
        // is silent. `teardown` now wraps both of its own round trips, so a port failure
        // reaches this line as a logged failure and a coherent snapshot rather than as a
        // rejection; what could still land here is a defect in the session's own tail. The
        // previous justification for swallowing it silently covered only
        // `releaseConnection`'s synchronous prefix, and said nothing about the meta write
        // one line below it, which can reject too.
        void teardown({ cause: "bookVanished", startedFrom }).catch((error: unknown) =>
          swallow("setBook", error),
        );
        return;
      }
      applyStalenessGate();
      resumeStoredConnection();
    },
    connect: () => runConnect(false),
    joinShared: () => (ports.pickerConfigured ? runConnect(true) : Promise.resolve()),
    async reconnect() {
      if (connecting || applying) return;
      try {
        // One operation with one capture at its true start — and this is that capture.
        // `runConnect`'s own is taken after the `metaStore.save` below, which is a real
        // window: the guard above catches a teardown already in flight, not one that starts
        // *and finishes* inside this write. Without this the user would pay for an OAuth
        // popup on a reconnect an erase had already overtaken, which is the very thing
        // defect 2 closed on the other route in.
        const endsAtStart = userEnds;
        // Read before forgetting: a connection this device joined via the Picker must
        // recover through the Picker too. The ordinary name search — `'me' in owners`,
        // added to stop a shared file colliding with the user's own book as
        // `SYNC_FILE_AMBIGUOUS` on an ordinary Connect — finds nothing for a file someone
        // else owns, so recovering a joined book through it would silently create a fresh
        // private `khesh-book.json` and fork the family off the shared one, while the copy
        // still called it "Reconnect to create it again".
        const meta = await ports.metaStore.load();
        // Forget the *persisted* address, and nothing else. `reconnect` has one call site,
        // the `SYNC_FILE_MISSING` row: the cached id names a Drive file that is gone, so
        // "forget the id, look again, create one if it really is gone" is the recovery, and
        // this write is what makes the next connect start from no id.
        await ports.metaStore.save({ fileId: null });
        if (userEnds !== endsAtStart) return;
        // Then abandon the old connection, exactly as every other flow does. Emptying
        // `current.fileId` in place is the mechanism BL-053 exists to rule out and this is
        // the last route that still did it: the old engine stays armed across the OAuth
        // popup below, its store reads that same field, and an in-flight or debounced cycle
        // finding it null takes `write`'s create-a-new-file path. Two `khesh-book.json` is
        // `SYNC_FILE_AMBIGUOUS`, which has no in-app recovery — a local edit, a sync that
        // fails with the file missing, and Reconnect inside the 3s debounce is the whole
        // path to it. Released holding its id instead, a doomed cycle 404s a dead id and
        // duplicates nothing; the replacement `Connection` starts at `fileId: null` by
        // construction, which is where the "create it if it is really gone" half comes from.
        //
        // Synchronously, ahead of `runConnect`: the prefix of `releaseConnection` disposes
        // the engine and drops the connection's standing before this function yields again,
        // and only `revoke()` is left in flight. Nothing here writes `connected` — the user
        // is reconnecting, not disconnecting, and the row this was tapped from lives in the
        // connected view. Should `runConnect` refuse (an erase, a teardown) or fail, the
        // session is left claiming a connection it no longer has: inert, still tearable down
        // by Disconnect, and one more tap on Reconnect from trying again.
        const displaced = current;
        if (displaced) {
          void releaseConnection(displaced).catch((error: unknown) =>
            swallow("reconnect: release", error),
          );
        }
        await runConnect(meta.joinedViaPicker, true);
      } catch (error) {
        swallow("reconnect", error);
      }
    },
    async disconnect() {
      try {
        await teardown({ cause: "userAction" });
      } catch (error) {
        swallow("disconnect", error);
      }
    },
    // A user tap may open the Google popup, which the silent path cannot.
    async reauth() {
      try {
        const conn = current;
        if (!conn) return;
        const token = await conn.auth.getToken(true);
        if (superseded(conn) || !token.ok) return;
        await conn.engine?.syncNow();
      } catch (error) {
        swallow("reauth", error);
      }
    },
    async applyChoice(choice, onStarted) {
      // Act only on a choice the live plan actually offers. A tap carries a value rendered
      // from some earlier plan, and between the render and the handler the plan can have
      // been dropped as stale, cancelled, or replaced by a second Connect. The screens
      // disable these buttons too; this is the half that does not depend on every future
      // screen remembering to.
      // `live === null` spelled out rather than left to `live?.plan ?? null`: the null case
      // is the same refusal either way (`isChoiceOffered(null, …)` is false), but written
      // this way TypeScript narrows `live` to non-null past the guard, which is what lets
      // the `applyAndFinalize` below read `live.viaPicker` — the Picker flag the plan was
      // reached through, which `runConnect`'s own local `usePicker` is long out of scope for
      // by the time a user taps a button on this screen.
      const live = stage.kind === "choosing" ? stage : null;
      if (live === null || !isChoiceOffered(live.plan, choice)) return;
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
        await applyAndFinalize(conn, choice, endsAtStart, live.viaPicker);
      } catch (error) {
        swallow("applyChoice", error);
      } finally {
        applying = false;
        // `applying` just left the one window `afterLocalStateChange` suppresses drops in.
        // A failed apply leaves `stage` exactly as it was, so if the book moved while it
        // ran, this is where that plan finally gets dropped rather than left showing
        // choices for a local side that no longer exists.
        //
        // The `publish()` below is unconditional and needed regardless: `activity.applying`
        // just changed and has to reach the cached snapshot even when the gate above is a
        // no-op (the common, successful-apply case — `finalize` already moved `stage` to
        // `IDLE` and published before this line runs). On the path where the gate *did*
        // just drop the plan, `applyStalenessGate()` has already published once on its own,
        // so this fires a second, harmless notification with nothing left to say — accepted
        // rather than threaded through as a "did it change" flag for one rare case.
        applyStalenessGate();
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
    syncNow() {
      current?.engine?.syncNow().catch((error: unknown) => swallow("syncNow", error));
    },
    resolveUseLocal() {
      current?.engine
        ?.resolveUseLocal()
        .catch((error: unknown) => swallow("resolveUseLocal", error));
    },
    resolveUseRemote() {
      current?.engine
        ?.resolveUseRemote()
        .catch((error: unknown) => swallow("resolveUseRemote", error));
    },
    // The connection and this session's own subscribers, and nothing else. The page-level
    // subscriptions belong to `attach`'s detach: they have the effect's lifetime, not the
    // session's, and undoing them here is what StrictMode's dev remount turned permanent.
    //
    // **Terminal, and not a lifecycle hook.** It revokes the token, which is the user's
    // decision and not a render's, so `SyncProvider` no longer calls it from an effect
    // cleanup — see the comment on its `attach` effect for why keeping both that call and a
    // ref-lifetime session was a contradiction. It leaves `connected`, `email` and `stage`
    // exactly as it found them, which is safe only because nothing goes on rendering the
    // session afterwards; ending a *live* connection and settling the snapshot with it is
    // `disconnect()`, and that is what every user-facing path calls.
    dispose() {
      listeners.clear();
      if (current) {
        void releaseConnection(current).catch((error: unknown) => swallow("dispose", error));
      }
    },
  };
}
