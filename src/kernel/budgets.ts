import { cloneBook, findAccount } from "./book-utils";
import { isCurrencyCode } from "./currency";
import { err, ok, type Result } from "./result";
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
  };
  const next = cloneBook(book);
  const index = next.budgets.findIndex((item) => sameKey(item, input));
  if (index === -1) next.budgets.push(budget);
  else next.budgets[index] = budget;
  return ok(next);
}

export function removeBudget(book: Book, key: BudgetKey): Result<Book> {
  const index = book.budgets.findIndex((item) => sameKey(item, key));
  if (index === -1) {
    return err("BUDGET_NOT_FOUND", "Budget not found", { ...key });
  }
  const next = cloneBook(book);
  next.budgets.splice(index, 1);
  return ok(next);
}
