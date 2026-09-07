import { journalScope, matchesJournalFilter, type JournalFilter } from "../kernel";
import type { Book, JournalEntry } from "../kernel";
import type { DueRow } from "../service/ledger-app";

export type JournalRow =
  | { kind: "entry"; entry: JournalEntry }
  | { kind: "pending"; due: DueRow };

function rowDate(row: JournalRow): string {
  return row.kind === "entry" ? row.entry.date : row.due.date;
}

function rowId(row: JournalRow): string {
  return row.kind === "entry" ? row.entry.id : row.due.entryId;
}

/**
 * The journal list: confirmed entries plus the occurrences still waiting on one.
 *
 * A pending row is not in `Book` — no balance, budget or statistic can see it — so it is
 * merged in here, at the edge, and filtered through the kernel's own predicate rather than
 * a second copy of that logic. `entries` arrives already filtered and sorted by
 * `listJournal`; the due rows are filtered here and the whole list re-sorted, newest first,
 * which is the order the journal has always used.
 */
export function journalRows(
  entries: JournalEntry[],
  due: DueRow[],
  book: Book,
  filter: JournalFilter | undefined,
): JournalRow[] {
  const scope = journalScope(book, filter?.accountId);
  const rows: JournalRow[] = [
    ...entries.map((entry): JournalRow => ({ kind: "entry", entry })),
    ...due
      .filter((row) => matchesJournalFilter(row.preview, filter, scope))
      .map((row): JournalRow => ({ kind: "pending", due: row })),
  ];
  rows.sort((a, b) => {
    const [x, y] = [rowDate(a), rowDate(b)];
    if (x !== y) return x < y ? 1 : -1;
    return rowId(a) < rowId(b) ? 1 : -1;
  });
  return rows;
}
