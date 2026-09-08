import { decodeEnvelope, encodeEnvelope } from "../adapters/sync-envelope";
import { bookFingerprint, mergeBooks } from "../kernel/merge";
import { validateBook } from "../kernel/validate";
import { err, ok, type Result } from "../kernel/result";
import type { Book } from "../kernel/types";
import type { LedgerRepository } from "../ports/ledger-repository";
import type { SyncStorePort } from "../ports/sync-store";

export type FirstConnectChoice = "useRemote" | "replaceRemote" | "merge";

export type RemoteInspection =
  | { kind: "empty" }
  | { kind: "book"; name: string; entryCount: number }
  | { kind: "unreadable"; errorCode: "SYNC_ENVELOPE_INVALID" | "SYNC_FORMAT_UNSUPPORTED" };

/** What the local side has to lose. `none` covers both "storage is empty" and "the
 * stored book failed to load": neither holds data a remote book could destroy. */
export type LocalState = "none" | "empty" | "real";

/**
 * What a first connect should do next, given both sides.
 *
 * - `apply` — act now, show no choice screen. The user tapped Connect and there is only
 *   one sensible outcome.
 * - `choose` — show these choices, in this order.
 * - `explain` — there is no action to offer; say why.
 */
export type FirstConnectPlan =
  | { kind: "apply"; choice: FirstConnectChoice }
  | { kind: "choose"; choices: FirstConnectChoice[] }
  | { kind: "explain"; reason: "remoteEmpty" | "remoteUnreadable" | "updateApp" };

/**
 * The whole first-connect decision, as a value.
 *
 * Two things live here that used to be spread between `SyncProvider.connect()` and
 * `SyncSection`'s markup: whether the flow acts immediately or asks, and which choices
 * are meaningful. Neither could see the local side before, which is why `merge` was
 * offered to a book with nothing in it — the case that doubles the root accounts,
 * because root ids are per-device (see BL-048).
 *
 * `remote` is the whole inspection, not just its `kind`: `unreadable` splits by
 * `errorCode`, and a remote written by a *newer* Khesh must never be offered for
 * overwrite.
 */
export function firstConnectOptions(
  local: LocalState,
  remote: RemoteInspection,
): FirstConnectPlan {
  if (remote.kind === "empty") {
    // Nothing in Drive to take. With a local book, uploading it is the only outcome and
    // needs no screen — today's behavior. Without one there is nothing to upload either,
    // and the honest answer is a sentence, not a failed action.
    return local === "none"
      ? { kind: "explain", reason: "remoteEmpty" }
      : { kind: "apply", choice: "replaceRemote" };
  }

  if (remote.kind === "unreadable") {
    if (remote.errorCode === "SYNC_FORMAT_UNSUPPORTED") {
      return { kind: "explain", reason: "updateApp" };
    }
    // Overwriting a corrupt remote works by uploading the local book, so it needs one.
    return local === "none"
      ? { kind: "explain", reason: "remoteUnreadable" }
      : { kind: "choose", choices: ["replaceRemote"] };
  }

  if (local === "none") return { kind: "choose", choices: ["useRemote"] };
  if (local === "empty") return { kind: "choose", choices: ["useRemote", "replaceRemote"] };
  return { kind: "choose", choices: ["useRemote", "merge", "replaceRemote"] };
}

export async function inspectRemote(store: SyncStorePort): Promise<Result<RemoteInspection>> {
  const readResult = await store.read();
  if (!readResult.ok) return readResult;
  if (readResult.value === null) return ok({ kind: "empty" });
  const decoded = decodeEnvelope(readResult.value.payload);
  if (!decoded.ok) {
    const errorCode =
      decoded.error.code === "SYNC_FORMAT_UNSUPPORTED" ? "SYNC_FORMAT_UNSUPPORTED" : "SYNC_ENVELOPE_INVALID";
    return ok({ kind: "unreadable", errorCode });
  }
  return ok({
    kind: "book",
    name: decoded.value.name,
    entryCount: decoded.value.journal.length,
  });
}

async function loadLocal(repo: LedgerRepository): Promise<Result<Book>> {
  const loaded = await repo.load();
  if (!loaded.ok) return loaded;
  if (loaded.value === null) return err("BOOK_INVALID", "No local book to connect");
  return ok(loaded.value);
}

async function uploadLocal(store: SyncStorePort, book: Book): Promise<Result<Book>> {
  const written = await store.write(encodeEnvelope(book));
  if (!written.ok) return written;
  return ok(book);
}

/** mergeBooks does not validate its own output. An ok merge that still fails here is a
 * kernel bug, not a user conflict: abort with the validation code, keep the local book,
 * and upload nothing. (The sync engine's cycle keeps its own copy of this pairing; the
 * two paths are independent, and neither should reach across for three statements.) */
function mergeValidated(local: Book, remote: Book): Result<Book> {
  const merged = mergeBooks(local, remote);
  if (!merged.ok) return merged;
  const valid = validateBook(merged.value);
  if (!valid.ok) return valid;
  return merged;
}

export type FirstConnectDeps = {
  repo: LedgerRepository;
  store: SyncStorePort;
  /**
   * The same lock the sync engine's cycle and every commit take. First connect is
   * one-shot but not single-flight on its own: a double-tapped choice button, or two
   * tabs both mid-connect, otherwise run two of the load/merge/save/write sequences
   * below against each other with no coordination at all. Default: unlocked, for the
   * single-writer callers.
   */
  runExclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
};

export async function applyFirstConnect(
  choice: FirstConnectChoice,
  deps: FirstConnectDeps,
): Promise<Result<Book>> {
  const runExclusive: <T>(fn: () => Promise<T>) => Promise<T> =
    deps.runExclusive ?? ((fn) => fn());
  return runExclusive(() => firstConnect(choice, deps));
}

async function firstConnect(
  choice: FirstConnectChoice,
  deps: FirstConnectDeps,
): Promise<Result<Book>> {
  const local = await loadLocal(deps.repo);
  if (!local.ok) return local;

  // replaceRemote is the recovery action offered for a remote the UI could not read
  // (corrupt payload, e.g.), so it must not itself depend on reading or decoding
  // whatever is actually there — it overwrites unconditionally.
  if (choice === "replaceRemote") return uploadLocal(deps.store, local.value);

  const readResult = await deps.store.read();
  if (!readResult.ok) return readResult;
  if (readResult.value === null) return uploadLocal(deps.store, local.value);

  const remote = decodeEnvelope(readResult.value.payload);
  if (!remote.ok) return remote;

  if (choice === "useRemote") {
    const saved = await deps.repo.save(remote.value);
    if (!saved.ok) return saved;
    return ok(remote.value);
  }

  const merged = mergeValidated(local.value, remote.value);
  if (!merged.ok) return merged;

  // `local` was read before the download. This flow is user-initiated and one-shot, so
  // the window is far narrower than the sync engine's — but it is the same window, and
  // another tab committing into the shared repository while the modal waits on Drive
  // would have its entry erased by the save below. Re-merge the fresh book against the
  // same downloaded remote; the reload is local, so it costs no store call.
  const current = await loadLocal(deps.repo);
  if (!current.ok) return current;
  const settled =
    bookFingerprint(current.value) === bookFingerprint(local.value)
      ? merged
      : mergeValidated(current.value, remote.value);
  if (!settled.ok) return settled;

  const saved = await deps.repo.save(settled.value);
  if (!saved.ok) return saved;
  const written = await deps.store.write(encodeEnvelope(settled.value));
  if (!written.ok) return written;
  return ok(settled.value);
}
