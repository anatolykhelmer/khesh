import type { Account, Book, Recurrence } from "./types";

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

/** Every live (non-deleted) rule that posts from or to `accountId` — a paused rule
 * still counts, since resuming it later would break the same way. */
export function recurrencesReferencing(book: Book, accountId: string): Recurrence[] {
  return book.recurrences.filter(
    (rule) => rule.fromAccountId === accountId || rule.lines.some((line) => line.toAccountId === accountId),
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

/**
 * True when adopting a different book here destroys nothing: no journal entries, no
 * budgets, no recurrence rules, no tombstones, and every account is an untouched
 * top-level group.
 *
 * The predicate deliberately does NOT compare against `ROOT_SEEDS`. Root names are read
 * from `i18n.t(...)` when the book is created (`src/service/ledger-app.ts`), so the
 * stored names are in whatever language was active then; comparing them with the current
 * translation would start lying the moment the user switches language. Names, types and
 * the number of roots are not inspected at all.
 *
 * Its meaning is "taking the remote book here loses nothing", not "this looks like a
 * seed" — which is why a lone tombstone or a single hand-made subcategory is enough to
 * make it false, even with an empty journal.
 */
export function holdsNoUserData(book: Book): boolean {
  if (book.journal.length > 0) return false;
  if (book.budgets.length > 0) return false;
  if (book.recurrences.length > 0) return false;
  if (book.tombstones.length > 0) return false;
  return book.accounts.every((account) => account.parentId === null && account.isPlaceholder);
}
