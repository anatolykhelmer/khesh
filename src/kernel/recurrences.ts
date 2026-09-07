import { cloneBook, findAccount } from "./book-utils";
import { isCalendarDate } from "./dates";
import { createId } from "./ids";
import { err, ok, type Result } from "./result";
import { addTombstone, clearTombstone } from "./tombstones";
import type { Book, Recurrence, RecurrenceLine, RecurrenceUnit } from "./types";
import { occurrencesBetween, shiftMonths } from "./recurrence-dates";
import { RECURRENCE_WINDOW_MONTHS } from "./occurrences";

const UNITS = new Set<RecurrenceUnit>(["week", "month", "year"]);

export type RecurrenceInput = {
  description: string;
  fromAccountId: string;
  lines: RecurrenceLine[];
  every: number;
  unit: RecurrenceUnit;
  startDate: string;
  endDate: string | null;
};

/** An error Result for invalid input, or null when valid. Mirrors the pattern of
 * `invalidEntryInput` in `src/service/ledger-app.ts`: same rules, checked before anything is written. */
function invalidInput(book: Book, input: RecurrenceInput): Result<Book> | null {
  if (!Number.isInteger(input.every) || input.every < 1 || !UNITS.has(input.unit)) {
    return err("RECURRENCE_SCHEDULE_INVALID", "Invalid recurrence interval", {
      every: input.every,
      unit: input.unit,
    });
  }
  if (!isCalendarDate(input.startDate)) {
    return err("RECURRENCE_SCHEDULE_INVALID", `Invalid start date ${input.startDate}`, {
      startDate: input.startDate,
    });
  }
  if (input.endDate !== null && (!isCalendarDate(input.endDate) || input.endDate < input.startDate)) {
    return err("RECURRENCE_SCHEDULE_INVALID", "End date must be null or on/after the start date", {
      endDate: input.endDate,
    });
  }
  if (input.lines.length === 0) {
    return err("ENTRY_TOO_FEW_ACCOUNTS", "Add at least one line");
  }

  const seen = new Set<string>();
  for (const line of input.lines) {
    if (!Number.isInteger(line.amount) || line.amount <= 0) {
      return err("ENTRY_AMOUNT_INVALID", "Amount must be an integer > 0", { amount: line.amount });
    }
    if (line.toAccountId === input.fromAccountId) {
      return err("ENTRY_TOO_FEW_ACCOUNTS", "From and To must be different accounts");
    }
    if (seen.has(line.toAccountId)) {
      return err("ENTRY_TOO_FEW_ACCOUNTS", "Each line must use a different account", {
        toAccountId: line.toAccountId,
      });
    }
    seen.add(line.toAccountId);
  }

  const currencies = new Set<string>();
  for (const accountId of [input.fromAccountId, ...input.lines.map((l) => l.toAccountId)]) {
    const account = findAccount(book, accountId);
    if (!account) return err("ACCOUNT_NOT_FOUND", "Account not found", { accountId });
    if (account.isPlaceholder) {
      return err("ACCOUNT_IS_PLACEHOLDER", "A recurrence cannot post to a category", { accountId });
    }
    currencies.add(account.currency);
  }
  // A stored rate would be a lie by the time the occurrence comes due, and the entry
  // cannot be posted without one. Refused here rather than degraded silently.
  if (currencies.size > 1) {
    return err("RECURRENCE_CURRENCY_MISMATCH", "Every account in a recurrence must share one currency", {
      currencies: [...currencies],
    });
  }
  return null;
}

function recordFrom(input: RecurrenceInput, id: string, carried: Pick<Recurrence, "pausedAt" | "skipped" | "deferred">, now: string): Recurrence {
  return {
    id,
    description: input.description,
    fromAccountId: input.fromAccountId,
    lines: input.lines.map((line) => ({ ...line })),
    every: input.every,
    unit: input.unit,
    startDate: input.startDate,
    endDate: input.endDate,
    pausedAt: carried.pausedAt,
    skipped: [...carried.skipped],
    deferred: [...carried.deferred],
    updatedAt: now,
  };
}

export function createRecurrence(
  book: Book,
  input: RecurrenceInput & { id?: string },
  now: string,
): Result<Book> {
  const invalid = invalidInput(book, input);
  if (invalid) return invalid;

  const id = input.id ?? createId();
  if (book.recurrences.some((rule) => rule.id === id)) {
    return err("RECURRENCE_ID_DUPLICATE", `Duplicate recurrence id ${id}`, { id });
  }
  const next = cloneBook(book);
  next.recurrences.push(recordFrom(input, id, { pausedAt: null, skipped: [], deferred: [] }, now));
  // A re-created record must not leave its own tombstone behind, the way setBudget does.
  clearTombstone(next, "recurrence", id);
  return ok(next);
}

/**
 * Replaces the template and the schedule; `pausedAt`, `skipped` and `deferred` are carried
 * over untouched. The id survives, which is what keeps entries already posted from this
 * rule attributed to it and out of the queue.
 */
export function updateRecurrence(
  book: Book,
  input: RecurrenceInput & { id: string },
  now: string,
): Result<Book> {
  const index = book.recurrences.findIndex((rule) => rule.id === input.id);
  if (index === -1) {
    return err("RECURRENCE_NOT_FOUND", "Recurrence not found", { id: input.id });
  }
  const invalid = invalidInput(book, input);
  if (invalid) return invalid;

  const next = cloneBook(book);
  next.recurrences[index] = recordFrom(input, input.id, next.recurrences[index], now);
  return ok(next);
}

export function deleteRecurrence(book: Book, id: string, now: string): Result<Book> {
  const index = book.recurrences.findIndex((rule) => rule.id === id);
  if (index === -1) {
    return err("RECURRENCE_NOT_FOUND", "Recurrence not found", { id });
  }
  const removed = book.recurrences[index];
  const next = cloneBook(book);
  next.recurrences.splice(index, 1);
  addTombstone(next, "recurrence", id, removed, now);
  return ok(next);
}

/** Dates the queue can no longer reach are dropped, so these lists stay bounded however
 * long the book lives. Sorted and de-duplicated so the record has one canonical form. */
function bounded(dates: readonly string[], today: string): string[] {
  const windowStart = shiftMonths(today, -RECURRENCE_WINDOW_MONTHS);
  return [...new Set(dates.filter((date) => date >= windowStart))].sort();
}

function withRule(
  book: Book,
  ruleId: string,
  change: (rule: Recurrence) => Recurrence,
  now: string,
): Result<Book> {
  const index = book.recurrences.findIndex((rule) => rule.id === ruleId);
  if (index === -1) {
    return err("RECURRENCE_NOT_FOUND", "Recurrence not found", { id: ruleId });
  }
  const next = cloneBook(book);
  next.recurrences[index] = { ...change(next.recurrences[index]), updatedAt: now };
  return ok(next);
}

/** Dismiss one occurrence for good. */
export function skipOccurrence(
  book: Book,
  ruleId: string,
  date: string,
  today: string,
  now: string,
): Result<Book> {
  if (!isCalendarDate(date) || !isCalendarDate(today)) {
    return err("RECURRENCE_SCHEDULE_INVALID", "Skip date must be a calendar date", { date, today });
  }
  return withRule(
    book,
    ruleId,
    (rule) => ({ ...rule, skipped: bounded([...rule.skipped, date], today) }),
    now,
  );
}

/** Hide one occurrence from the Dashboard card; it stays pending in the journal. */
export function deferOccurrence(
  book: Book,
  ruleId: string,
  date: string,
  today: string,
  now: string,
): Result<Book> {
  if (!isCalendarDate(date) || !isCalendarDate(today)) {
    return err("RECURRENCE_SCHEDULE_INVALID", "Defer date must be a calendar date", { date, today });
  }
  return withRule(
    book,
    ruleId,
    (rule) => ({ ...rule, deferred: bounded([...rule.deferred, date], today) }),
    now,
  );
}

/**
 * Pause or resume. While `pausedAt` is set the rule yields nothing at all.
 *
 * Resuming does not replay the pause: every occurrence date inside `[pausedAt, today]` is
 * written into `skipped` in the same command that clears `pausedAt`. That is what the word
 * promises — while a rule is paused, nothing is owed. Occurrences that were already pending
 * *before* the pause are untouched, so pausing is not a way to clear a backlog.
 *
 * One write at resume time, so nothing accrues per device while the pause lasts, and both
 * fields travel together inside a single rule claim through a merge.
 */
export function setRecurrencePaused(
  book: Book,
  ruleId: string,
  paused: boolean,
  today: string,
  now: string,
): Result<Book> {
  if (!isCalendarDate(today)) {
    return err("RECURRENCE_SCHEDULE_INVALID", "Today must be a calendar date", { today });
  }
  return withRule(
    book,
    ruleId,
    (rule) => {
      if (paused)
        // The pause start is what the resume span is measured from, so the first pause wins.
        // Re-pausing with a different today would forgive less (or more) than the pause actually covered.
        return rule.pausedAt === null ? { ...rule, pausedAt: today } : rule;
      if (rule.pausedAt === null) return rule;
      const from = rule.pausedAt;
      const to = rule.endDate !== null && rule.endDate < today ? rule.endDate : today;
      const span = occurrencesBetween(rule.startDate, rule.every, rule.unit, from, to);
      return { ...rule, pausedAt: null, skipped: bounded([...rule.skipped, ...span], today) };
    },
    now,
  );
}
