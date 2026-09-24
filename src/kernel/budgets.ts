import { cloneBook, findAccount, replaceIfChanged } from "./book-utils";
import { isCurrencyCode } from "./currency";
import { err, ok, type Result } from "./result";
import { addTombstone, budgetKeyOf, clearTombstone } from "./tombstones";
import type { Book, Budget, BudgetPeriod, CurrencyCode, MinorUnits } from "./types";

type BudgetKey = { accountId: string; period: BudgetPeriod; currency: CurrencyCode };

function sameKey(budget: Budget, key: BudgetKey): boolean {
  return (
    budget.accountId === key.accountId &&
    budget.period === key.period &&
    budget.currency === key.currency
  );
}

/** Upsert on (accountId, period, currency) — the natural key of a limit. */
export function setBudget(
  book: Book,
  input: BudgetKey & { limit: MinorUnits },
  now: string,
): Result<Book> {
  const account = findAccount(book, input.accountId);
  if (!account) {
    return err("ACCOUNT_NOT_FOUND", "Account not found", { id: input.accountId });
  }
  if (account.type !== "expense") {
    return err("ACCOUNT_TYPE_MISMATCH", "Budgets cover expense accounts only", {
      id: input.accountId,
    });
  }
  if (!isCurrencyCode(input.currency)) {
    return err("INVALID_CURRENCY_CODE", `Invalid currency ${input.currency}`, {
      currency: input.currency,
    });
  }
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    return err("BUDGET_LIMIT_INVALID", "Limit must be an integer greater than zero", {
      limit: input.limit,
    });
  }

  const budget: Budget = {
    accountId: input.accountId,
    period: input.period,
    currency: input.currency,
    limit: input.limit,
    updatedAt: now,
  };
  const key = budgetKeyOf(input);
  const index = book.budgets.findIndex((item) => sameKey(item, input));
  if (index === -1) {
    const next = cloneBook(book);
    next.budgets.push(budget);
    clearTombstone(next, "budget", key);
    return ok(next);
  }
  const replaced = replaceIfChanged(book, "budgets", index, budget, now);
  if (replaced !== book) {
    clearTombstone(replaced, "budget", key);
    return ok(replaced);
  }
  // Equal record, but the key still carries a tombstone — a live budget and a tombstone
  // both claiming one key is exactly what `validateBook` calls a tombstone shadowing a
  // live record, so `book` did not come from a real merge or an earlier call here: both
  // keep this invariant themselves (`merge.ts`'s root-collapse rung clears the tombstone
  // whenever it keeps a moved budget over one, the same way this function does below).
  // What is left is a book from outside the kernel — an import, a hand-edited file —
  // that reached this call already carrying the shadow. Clearing it is still a change,
  // so the record is re-stamped even though its content did not move: a stamp newer than
  // the tombstone's own `deletedAt` is what keeps a future merge from reading the
  // tombstone as the newer claim and reintroducing the shadow it just cleared.
  if (!book.tombstones.some((t) => t.kind === "budget" && t.key === key)) return ok(book);
  const next = cloneBook(book);
  next.budgets[index] = budget;
  clearTombstone(next, "budget", key);
  return ok(next);
}

export function removeBudget(book: Book, key: BudgetKey, now: string): Result<Book> {
  const index = book.budgets.findIndex((item) => sameKey(item, key));
  if (index === -1) {
    return err("BUDGET_NOT_FOUND", "Budget not found", { ...key });
  }
  const removed = book.budgets[index];
  const next = cloneBook(book);
  next.budgets.splice(index, 1);
  addTombstone(next, "budget", budgetKeyOf(key), removed, now);
  return ok(next);
}
