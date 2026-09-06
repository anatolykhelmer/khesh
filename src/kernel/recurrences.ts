import { cloneBook, findAccount } from "./book-utils";
import { isCalendarDate } from "./dates";
import { createId } from "./ids";
import { err, ok, type Result } from "./result";
import { addTombstone, clearTombstone } from "./tombstones";
import type { Book, Recurrence, RecurrenceLine, RecurrenceUnit } from "./types";

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

/** An error Result for invalid input, or null when valid. Mirrors the journal's own
 * `invalidEntryInput`: same rules, checked before anything is written. */
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
