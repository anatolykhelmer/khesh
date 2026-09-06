import { err, ok, type Result } from "../kernel/result";
import { normalizeBook, type StoredBook } from "../kernel/normalize";
import { validateBook } from "../kernel/validate";
import type { Book } from "../kernel/types";

export const SYNC_FORMAT = 1;

/** The exact fixed-width form `new Date().toISOString()` (and EPOCH) produce.
 * mergeBooks compares `updatedAt`/`deletedAt` strings lexicographically, which only
 * agrees with real instant order for this one shape — a hand-edited Drive file can
 * carry an offset form instead (e.g. "...+03:00"), which sorts by its digits rather
 * than the instant it names. Rejecting anything else at the ingest boundary is what
 * lets mergeBooks stay clock-free and cheap. */
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isCanonicalTimestamp(value: unknown): boolean {
  return typeof value === "string" && CANONICAL_TIMESTAMP.test(value);
}

/** Array.isArray plus a `null`-element check: what normalizeBook's `stamp` helper
 * needs before it can map over a legacy record list without dereferencing a `null`. */
function isStampable(value: unknown): boolean {
  return Array.isArray(value) && value.every((element) => element !== null);
}

/** Called only after `validateBook` has passed, so every timestamp below is already
 * known to be *a* string — this narrows that to the one shape a lexicographic
 * comparison may safely treat as time order. */
function hasOnlyCanonicalTimestamps(book: Book): boolean {
  if (!isCanonicalTimestamp(book.metaUpdatedAt)) return false;
  for (const account of book.accounts) {
    if (!isCanonicalTimestamp(account.updatedAt)) return false;
  }
  for (const entry of book.journal) {
    if (!isCanonicalTimestamp(entry.updatedAt)) return false;
  }
  for (const budget of book.budgets) {
    if (!isCanonicalTimestamp(budget.updatedAt)) return false;
  }
  for (const stone of book.tombstones) {
    if (!isCanonicalTimestamp(stone.deletedAt)) return false;
  }
  return true;
}

/** The Drive file wraps the book so encryption and format changes can arrive later
 * without a migration: unknown futures are a defined state, not a parse error. */
export function encodeEnvelope(book: Book): string {
  return JSON.stringify({ app: "khesh", format: SYNC_FORMAT, encrypted: false, book });
}

export function decodeEnvelope(raw: string): Result<Book> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err("SYNC_ENVELOPE_INVALID", "Envelope is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return err("SYNC_ENVELOPE_INVALID", "Envelope is not an object");
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.app !== "khesh" || typeof envelope.format !== "number") {
    return err("SYNC_ENVELOPE_INVALID", "Not a khesh sync envelope");
  }
  if (envelope.format > SYNC_FORMAT || envelope.encrypted === true) {
    return err("SYNC_FORMAT_UNSUPPORTED", "Envelope from a newer app version", {
      format: envelope.format,
      encrypted: envelope.encrypted === true,
    });
  }
  const rawBook = envelope.book;
  if (typeof rawBook !== "object" || rawBook === null) {
    return err("SYNC_ENVELOPE_INVALID", "Envelope has no book");
  }
  const bookRecord = rawBook as Record<string, unknown>;
  const version = bookRecord.schemaVersion;
  if (version !== 1 && version !== 2) {
    if (typeof version === "number" && version > 2) {
      return err("SYNC_FORMAT_UNSUPPORTED", "Book from a newer app version", { schemaVersion: version });
    }
    return err("SYNC_ENVELOPE_INVALID", "Book has no usable schemaVersion");
  }
  // normalizeBook's v1 migration path maps `stamp` over `accounts`/`journal`/`budgets`
  // unconditionally, and `stamp` dereferences `record.updatedAt` directly on each
  // element — a `null` element throws there even though the array itself is
  // well-shaped. decodeEnvelope is the only caller that hands normalizeBook raw,
  // unvalidated external JSON, so this has to be checked here rather than inside
  // normalizeBook. `budgets` is optional at v1: a missing or non-array value is fine
  // (normalizeBook substitutes `[]`) — only a `null` element inside an actual array
  // reaches `stamp` unsafely.
  if (!isStampable(bookRecord.accounts) || !isStampable(bookRecord.journal)) {
    return err("SYNC_ENVELOPE_INVALID", "Book accounts or journal is malformed");
  }
  if (Array.isArray(bookRecord.budgets) && !isStampable(bookRecord.budgets)) {
    return err("SYNC_ENVELOPE_INVALID", "Book budgets is malformed");
  }
  const book = normalizeBook(rawBook as StoredBook);
  const valid = validateBook(book);
  if (!valid.ok) {
    return err("SYNC_ENVELOPE_INVALID", "Envelope book failed validation", {
      cause: valid.error,
    });
  }
  if (!hasOnlyCanonicalTimestamps(book)) {
    return err("SYNC_ENVELOPE_INVALID", "Book contains a non-canonical timestamp");
  }
  return ok(book);
}
