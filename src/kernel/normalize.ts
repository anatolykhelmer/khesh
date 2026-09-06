import type { Account, Book, Budget, JournalEntry, Recurrence, Tombstone } from "./types";

export const EPOCH = "1970-01-01T00:00:00.000Z";

type LegacyRecord<T> = Omit<T, "updatedAt"> & { updatedAt?: string };

/** The shape schemaVersion 1 snapshots have on disk and in old export files. */
export interface LegacyBookV1 {
  schemaVersion: 1;
  name: string;
  homeCurrency: string;
  accounts: Array<LegacyRecord<Account>>;
  journal: Array<LegacyRecord<JournalEntry>>;
  budgets?: Array<LegacyRecord<Budget>>;
}

/** The shape schemaVersion 2 snapshots have on disk and in old export files. */
export interface LegacyBookV2 {
  schemaVersion: 2;
  name: string;
  homeCurrency: string;
  metaUpdatedAt: string;
  accounts: Account[];
  journal: JournalEntry[];
  budgets: Budget[];
  tombstones: Tombstone[];
}

export type StoredBook = Book | LegacyBookV2 | LegacyBookV1;

function stamp<T extends { updatedAt?: string }>(record: T): T & { updatedAt: string } {
  return { ...record, updatedAt: record.updatedAt ?? EPOCH };
}

/**
 * Bring any stored snapshot (v1 export, v1 IndexedDB value, v2, or current v3) to the
 * v3 shape. Missing timestamps become EPOCH, so any real edit anywhere beats an
 * unmigrated record in a merge. Called at every read boundary before validation.
 *
 * An already-v3 book is returned **by reference**, not copied — callers that intend
 * to mutate must clone it themselves.
 *
 * A snapshot from a *newer* schema is likewise returned untouched rather than
 * migrated: rewriting it as v3 would drop the fields this build cannot see, and the
 * next save would persist the truncation. An installed PWA can run a weeks-old
 * precached shell against a newer book, so this is reachable. `validateBook` rejects
 * it at the same read boundary, which is how the refusal reaches the caller as an
 * error Result.
 */
export function normalizeBook(book: StoredBook): Book {
  if (book.schemaVersion > 3) return book as Book;
  if (
    book.schemaVersion === 3 &&
    typeof book.metaUpdatedAt === "string" &&
    Array.isArray(book.tombstones) &&
    Array.isArray(book.recurrences)
  ) {
    return book;
  }
  // Widened to the legacy shape so `stamp` infers one element type across both versions.
  const accounts: Array<LegacyRecord<Account>> = book.accounts;
  const journal: Array<LegacyRecord<JournalEntry>> = book.journal;
  const budgets: Array<LegacyRecord<Budget>> = Array.isArray(book.budgets) ? book.budgets : [];
  const recurrences: Recurrence[] =
    "recurrences" in book && Array.isArray(book.recurrences) ? book.recurrences : [];
  return {
    schemaVersion: 3,
    name: book.name,
    homeCurrency: book.homeCurrency,
    metaUpdatedAt:
      "metaUpdatedAt" in book && typeof book.metaUpdatedAt === "string" ? book.metaUpdatedAt : EPOCH,
    accounts: accounts.map(stamp),
    journal: journal.map(stamp),
    budgets: budgets.map(stamp),
    recurrences,
    tombstones: "tombstones" in book && Array.isArray(book.tombstones) ? book.tombstones : [],
  };
}
