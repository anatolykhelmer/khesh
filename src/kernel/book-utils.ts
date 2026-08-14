import type { Account, Book } from "./types";

export function cloneBook(book: Book): Book {
  return structuredClone(book);
}

export function findAccount(book: Book, id: string): Account | undefined {
  return book.accounts.find((account) => account.id === id);
}

export function hasChildren(book: Book, id: string): boolean {
  return book.accounts.some((account) => account.parentId === id);
}

export function hasPostings(book: Book, accountId: string): boolean {
  return book.journal.some((entry) =>
    entry.postings.some((posting) => posting.accountId === accountId),
  );
}

export function siblingNameTaken(
  book: Book,
  parentId: string | null,
  name: string,
  exceptId?: string,
): boolean {
  return book.accounts.some(
    (account) =>
      account.parentId === parentId &&
      account.name === name &&
      account.id !== exceptId,
  );
}

export function wouldCreateCycle(book: Book, accountId: string, newParentId: string): boolean {
  let current: string | null = newParentId;
  const seen = new Set<string>();
  while (current) {
    if (current === accountId) return true;
    if (seen.has(current)) return true;
    seen.add(current);
    current = findAccount(book, current)?.parentId ?? null;
  }
  return false;
}
