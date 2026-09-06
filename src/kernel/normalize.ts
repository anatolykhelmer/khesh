import type { Account, Book, Budget, JournalEntry } from "./types";

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

export type StoredBook = Book | LegacyBookV1;

function stamp<T extends { updatedAt?: string }>(record: T): T & { updatedAt: string } {
  return { ...record, updatedAt: record.updatedAt ?? EPOCH };
}

/**
 * Bring any stored snapshot (v1 export, v1 IndexedDB value, or current v2) to the
 * v2 shape. Missing timestamps become EPOCH, so any real edit anywhere beats an
 * unmigrated record in a merge. Called at every read boundary before validation.
 *
 * An already-v2 book is returned **by reference**, not copied — callers that intend
 * to mutate must clone it themselves.
 *
 * A snapshot from a *newer* schema is likewise returned untouched rather than
 * migrated: rewriting it as v2 would drop the fields this build cannot see, and the
 * next save would persist the truncation. An installed PWA can run a weeks-old
 * precached shell against a newer book, so this is reachable. `validateBook` rejects
 * it at the same read boundary, which is how the refusal reaches the caller as an
 * error Result.
 */
export function normalizeBook(book: StoredBook): Book {
  if (book.schemaVersion > 2) return book as Book;
  if (
    book.schemaVersion === 2 &&
    typeof book.metaUpdatedAt === "string" &&
    Array.isArray(book.tombstones)
  ) {
    return book;
  }
  // Widened to the legacy shape so `stamp` infers one element type across both versions.
  const accounts: Array<LegacyRecord<Account>> = book.accounts;
  const journal: Array<LegacyRecord<JournalEntry>> = book.journal;
  const budgets: Array<LegacyRecord<Budget>> = Array.isArray(book.budgets) ? book.budgets : [];
  return {
    schemaVersion: 2,
    name: book.name,
    homeCurrency: book.homeCurrency,
    metaUpdatedAt: "metaUpdatedAt" in book && typeof book.metaUpdatedAt === "string" ? book.metaUpdatedAt : EPOCH,
    accounts: accounts.map(stamp),
    journal: journal.map(stamp),
    budgets: budgets.map(stamp),
    tombstones: "tombstones" in book && Array.isArray(book.tombstones) ? book.tombstones : [],
  };
}
