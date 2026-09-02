import type { Account, Book, Budget, BudgetPeriod, CurrencyCode, JournalEntry, TombstoneKind } from "./types";

export function budgetKeyOf(b: {
  accountId: string;
  period: BudgetPeriod;
  currency: CurrencyCode;
}): string {
  return `${b.accountId}|${b.period}|${b.currency}`;
}

/** Mutates `book` (call on a cloned book only). Replaces any tombstone with the same kind+key. */
export function addTombstone(
  book: Book,
  kind: TombstoneKind,
  key: string,
  record: Account | JournalEntry | Budget,
  deletedAt: string,
): void {
  book.tombstones = book.tombstones.filter((t) => !(t.kind === kind && t.key === key));
  book.tombstones.push({ kind, key, deletedAt, record: structuredClone(record) });
}

/** Mutates `book` (call on a cloned book only). A re-created record must not leave its own tombstone behind. */
export function clearTombstone(book: Book, kind: TombstoneKind, key: string): void {
  book.tombstones = book.tombstones.filter((t) => !(t.kind === kind && t.key === key));
}
