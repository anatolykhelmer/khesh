import type { Book } from "./types";

/**
 * A snapshot written before budgets existed carries no `budgets`. Give it an empty
 * list so the rest of the code can treat the field as always present. Called at the
 * two read boundaries — JSON import and the IndexedDB load — before validation.
 */
export function normalizeBook(book: Book): Book {
  if (Array.isArray(book.budgets)) return book;
  return { ...book, budgets: [] };
}
