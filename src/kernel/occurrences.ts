import { occurrencesBetween, shiftMonths } from "./recurrence-dates";
import type { Book } from "./types";

/**
 * The id an entry posted from a recurrence carries. Deterministic on purpose: two devices
 * confirming the same occurrence offline produce the same id, so `mergeBooks` collapses
 * them into one entry under the rules it already has, and a duplicate payment cannot exist.
 *
 * This is the only place the format is written. Nothing reads a date back out of an id —
 * an entry's own `date` may differ from its occurrence date, and legitimately does when a
 * bill due on the 1st is paid on the 3rd.
 */
export function recurrenceEntryId(ruleId: string, date: string): string {
  return `rec:${ruleId}:${date}`;
}

/** How far back the queue looks. A rule started before this offers only the last year of
 * occurrences: it bounds both the work per evaluation and the amount of history one
 * mistyped start date can dump into the queue. */
export const RECURRENCE_WINDOW_MONTHS = 12;

export interface DueOccurrence {
  ruleId: string;
  date: string;
  /** The id this occurrence would be posted under; also how "already posted" is decided. */
  entryId: string;
  /** Dismissed from the Dashboard card, still pending in the journal. */
  deferred: boolean;
}

/**
 * Every occurrence that is neither posted, nor posted-then-deleted, nor skipped — oldest
 * first, and never later than `today`.
 *
 * One pass over the journal and one over the tombstones build the lookup sets; each
 * candidate date then costs O(1). The window caps a rule at 53 dates, so the whole
 * evaluation is linear in the book and bounded per rule, however old the book gets.
 */
export function dueOccurrences(book: Book, today: string): DueOccurrence[] {
  const posted = new Set(book.journal.map((entry) => entry.id));
  const buried = new Set(
    book.tombstones.filter((stone) => stone.kind === "entry").map((stone) => stone.key),
  );
  const windowStart = shiftMonths(today, -RECURRENCE_WINDOW_MONTHS);

  const due: DueOccurrence[] = [];
  for (const rule of book.recurrences) {
    if (rule.pausedAt !== null) continue;
    const from = rule.startDate > windowStart ? rule.startDate : windowStart;
    const to = rule.endDate !== null && rule.endDate < today ? rule.endDate : today;
    const skipped = new Set(rule.skipped);
    const deferred = new Set(rule.deferred);
    for (const date of occurrencesBetween(rule.startDate, rule.every, rule.unit, from, to)) {
      if (skipped.has(date)) continue;
      const entryId = recurrenceEntryId(rule.id, date);
      if (posted.has(entryId) || buried.has(entryId)) continue;
      due.push({ ruleId: rule.id, date, entryId, deferred: deferred.has(date) });
    }
  }
  // Oldest first: the queue is a backlog to work through, not a feed.
  due.sort((a, b) => (a.date === b.date ? (a.entryId < b.entryId ? -1 : 1) : a.date < b.date ? -1 : 1));
  return due;
}
