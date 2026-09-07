import { cloneBook } from "./book-utils";
import { isCalendarDate } from "./dates";
import { validatePostings, type PostingInput } from "./entry-validation";
import { createId } from "./ids";
import { err, ok, type Result } from "./result";
import { addTombstone, clearTombstone } from "./tombstones";
import type { Book, FxSpec } from "./types";

export function postEntry(
  book: Book,
  input: {
    /** Supplied only by a recurrence, which needs the id to be a function of the
     * occurrence rather than of the device that happened to confirm it. */
    id?: string;
    date: string;
    description: string;
    postings: PostingInput[];
    fx?: FxSpec;
  },
  now: string,
): Result<Book> {
  if (!isCalendarDate(input.date)) {
    return err("ENTRY_DATE_INVALID", `Invalid date ${input.date}`, { date: input.date });
  }
  if (input.id !== undefined && book.journal.some((entry) => entry.id === input.id)) {
    return err("ENTRY_ID_DUPLICATE", `Duplicate journal id ${input.id}`, { id: input.id });
  }
  const validated = validatePostings(book, input.postings, "standard", input.fx);
  if (!validated.ok) return validated;

  const id = input.id ?? createId();
  const next = cloneBook(book);
  next.journal.push({
    id,
    date: input.date,
    description: input.description,
    kind: "standard",
    postings: input.postings.map((posting) => ({ ...posting })),
    ...(input.fx ? { fx: { ...input.fx } } : {}),
    updatedAt: now,
  });
  // A re-created record must not leave its own tombstone behind — that shadowing is
  // exactly what validateBook rejects. Only reachable for an explicit id; a fresh ulid
  // has never been deleted.
  if (input.id !== undefined) clearTombstone(next, "entry", input.id);
  return ok(next);
}

export function updateEntry(
  book: Book,
  input: {
    id: string;
    date?: string;
    description?: string;
    postings?: PostingInput[];
    fx?: FxSpec | null;
  },
  now: string,
): Result<Book> {
  const existing = book.journal.find((entry) => entry.id === input.id);
  if (!existing) {
    return err("ENTRY_NOT_FOUND", "Journal entry not found", { id: input.id });
  }

  const date = input.date ?? existing.date;
  if (!isCalendarDate(date)) {
    return err("ENTRY_DATE_INVALID", `Invalid date ${date}`, { date });
  }

  const description = input.description ?? existing.description;
  const postings = input.postings ?? existing.postings;
  const fx =
    input.fx === undefined ? existing.fx : input.fx === null ? undefined : input.fx;

  const validated = validatePostings(book, postings, existing.kind, fx);
  if (!validated.ok) return validated;

  const next = cloneBook(book);
  const index = next.journal.findIndex((entry) => entry.id === existing.id);
  const updated = {
    ...next.journal[index],
    date,
    description,
    postings: postings.map((posting) => ({ ...posting })),
    updatedAt: now,
  };
  if (fx) updated.fx = { ...fx };
  else delete updated.fx;
  next.journal[index] = updated;
  return ok(next);
}

export function deleteEntry(book: Book, id: string, now: string): Result<Book> {
  const entry = book.journal.find((item) => item.id === id);
  if (!entry) {
    return err("ENTRY_NOT_FOUND", "Journal entry not found", { id });
  }
  const next = cloneBook(book);
  next.journal = next.journal.filter((item) => item.id !== id);
  addTombstone(next, "entry", id, entry, now);
  return ok(next);
}
