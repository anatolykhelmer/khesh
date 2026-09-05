import type { Account, Book } from "./types";

export function cloneBook(book: Book): Book {
  return structuredClone(book);
}

/**
 * A malformed element is skipped, not dereferenced. `validateBook` scans through
 * here, and its contract is to return a Result for any input — including a
 * corrupted snapshot that reached it without a shape check.
 */
export function findAccount(book: Book, id: string): Account | undefined {
  return book.accounts.find((account) => account?.id === id);
}

export function hasChildren(book: Book, id: string): boolean {
  return book.accounts.some((account) => account.parentId === id);
}

export function hasPostings(book: Book, accountId: string): boolean {
  return book.journal.some((entry) =>
    entry.postings.some((posting) => posting.accountId === accountId),
  );
}

/** Skips a malformed element for the same reason as `findAccount`. */
export function siblingNameTaken(
  book: Book,
  parentId: string | null,
  name: string,
  exceptId?: string,
): boolean {
  return book.accounts.some(
    (account) =>
      account != null &&
      account.parentId === parentId &&
      account.name === name &&
      account.id !== exceptId,
  );
}

/**
 * Every account below `rootId`, depth-first. Skips accounts already visited, so a
 * book that skipped validation and holds a parent cycle cannot recurse forever.
 */
export function descendants(book: Book, rootId: string): Account[] {
  const result: Account[] = [];
  const seen = new Set<string>([rootId]);
  const walk = (parentId: string) => {
    for (const account of book.accounts) {
      if (account.parentId !== parentId || seen.has(account.id)) continue;
      seen.add(account.id);
      result.push(account);
      walk(account.id);
    }
  };
  walk(rootId);
  return result;
}

/**
 * Walks parent links upward from `startId`, yielding each ancestor nearest-first.
 * The starting account is not yielded. Stops on a repeat visit, so a book that
 * skipped validation and holds a parent cycle cannot spin here forever.
 */
export function* ancestorsOf(book: Book, startId: string): Generator<Account> {
  const seen = new Set<string>([startId]);
  let current = findAccount(book, startId)?.parentId ?? null;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const account = findAccount(book, current);
    if (!account) return;
    yield account;
    current = account.parentId;
  }
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
