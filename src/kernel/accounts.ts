import {
  cloneBook,
  findAccount,
  hasChildren,
  hasPostings,
  recurrencesReferencing,
  siblingNameTaken,
  wouldCreateCycle,
} from "./book-utils";
import { isCurrencyCode } from "./currency";
import { createId } from "./ids";
import { err, ok, type Result } from "./result";
import { addTombstone, budgetKeyOf } from "./tombstones";
import type { AccountType, Book, CurrencyCode } from "./types";

export function createAccount(
  book: Book,
  input: {
    parentId: string | null;
    name: string;
    type: AccountType;
    currency: CurrencyCode;
    isPlaceholder: boolean;
  },
  now: string,
): Result<Book> {
  const name = input.name.trim();
  if (name.length === 0) {
    return err("ACCOUNT_NAME_INVALID", "Account name must be non-empty");
  }
  if (!isCurrencyCode(input.currency)) {
    return err("INVALID_CURRENCY_CODE", `Invalid currency ${input.currency}`, {
      currency: input.currency,
    });
  }
  if (input.parentId !== null) {
    const parent = findAccount(book, input.parentId);
    if (!parent) {
      return err("ACCOUNT_PARENT_INVALID", "Parent account not found", {
        parentId: input.parentId,
      });
    }
    if (!parent.isPlaceholder) {
      return err(
        "ACCOUNT_PARENT_NOT_PLACEHOLDER",
        "Only placeholder accounts may have children",
        { parentId: input.parentId },
      );
    }
    if (parent.type !== input.type) {
      return err("ACCOUNT_TYPE_MISMATCH", "Child type must match parent type", {
        parentType: parent.type,
        type: input.type,
      });
    }
  }
  if (siblingNameTaken(book, input.parentId, name)) {
    return err("ACCOUNT_NAME_DUPLICATE", "Account name already used among siblings", {
      name,
      parentId: input.parentId,
    });
  }

  const next = cloneBook(book);
  next.accounts.push({
    id: createId(),
    parentId: input.parentId,
    name,
    type: input.type,
    currency: input.currency,
    isPlaceholder: input.isPlaceholder,
    updatedAt: now,
  });
  return ok(next);
}

export function updateAccount(
  book: Book,
  input: {
    id: string;
    name?: string;
    parentId?: string | null;
    isPlaceholder?: boolean;
    type?: AccountType;
    currency?: CurrencyCode;
  },
  now: string,
): Result<Book> {
  const account = findAccount(book, input.id);
  if (!account) {
    return err("ACCOUNT_NOT_FOUND", "Account not found", { id: input.id });
  }

  const name = input.name === undefined ? account.name : input.name.trim();
  if (name.length === 0) {
    return err("ACCOUNT_NAME_INVALID", "Account name must be non-empty");
  }

  const parentId = input.parentId === undefined ? account.parentId : input.parentId;
  const isPlaceholder =
    input.isPlaceholder === undefined ? account.isPlaceholder : input.isPlaceholder;
  const type = input.type === undefined ? account.type : input.type;
  const currency = input.currency === undefined ? account.currency : input.currency;

  if (input.currency !== undefined && !isCurrencyCode(input.currency)) {
    return err("INVALID_CURRENCY_CODE", `Invalid currency ${input.currency}`, {
      currency: input.currency,
    });
  }

  if (type !== account.type) {
    if (hasPostings(book, account.id)) {
      return err("ACCOUNT_TYPE_LOCKED", "Cannot change type after postings", {
        id: account.id,
      });
    }
    if (hasChildren(book, account.id)) {
      return err("ACCOUNT_HAS_CHILDREN", "Cannot change type while account has children", {
        id: account.id,
      });
    }
  }

  if (currency !== account.currency && hasPostings(book, account.id)) {
    return err("ACCOUNT_CURRENCY_LOCKED", "Cannot change currency after postings", {
      id: account.id,
    });
  }

  // A recurrence requires every account it touches to share one currency
  // (RECURRENCE_CURRENCY_MISMATCH in validateBook). Changing this account's currency
  // out from under a live rule would write a book validateBook then refuses to load —
  // refuse here instead, the same way ACCOUNT_HAS_POSTINGS refuses below.
  if (currency !== account.currency) {
    const brokenByCurrency = recurrencesReferencing(book, account.id).some((rule) => {
      const others = [rule.fromAccountId, ...rule.lines.map((line) => line.toAccountId)].filter(
        (otherId) => otherId !== account.id,
      );
      return others.some((otherId) => findAccount(book, otherId)?.currency !== currency);
    });
    if (brokenByCurrency) {
      return err("ACCOUNT_HAS_RECURRENCES", "Cannot change currency while a recurring rule depends on it", {
        id: account.id,
      });
    }
  }

  if (!isPlaceholder && hasChildren(book, account.id)) {
    return err("ACCOUNT_HAS_CHILDREN", "Cannot unset placeholder while account has children", {
      id: account.id,
    });
  }

  if (isPlaceholder && hasPostings(book, account.id)) {
    return err("ACCOUNT_HAS_POSTINGS", "Cannot make placeholder after postings", {
      id: account.id,
    });
  }

  // A recurrence cannot post to a placeholder (ACCOUNT_IS_PLACEHOLDER in validateBook).
  // Deleting an account is an explicit destructive act, so deleteAccount cascades its
  // rules with it; flipping a leaf into a category is not destructive on its face, so
  // it must refuse rather than silently orphan the rule into an unloadable book.
  if (isPlaceholder && recurrencesReferencing(book, account.id).length > 0) {
    return err("ACCOUNT_HAS_RECURRENCES", "Cannot make placeholder while a recurring rule posts to it", {
      id: account.id,
    });
  }

  if (parentId !== null) {
    const parent = findAccount(book, parentId);
    if (!parent) {
      return err("ACCOUNT_PARENT_INVALID", "Parent account not found", { parentId });
    }
    if (wouldCreateCycle(book, account.id, parentId)) {
      return err("ACCOUNT_CYCLE", "Parent would create a cycle", { id: account.id, parentId });
    }
    if (!parent.isPlaceholder) {
      return err(
        "ACCOUNT_PARENT_NOT_PLACEHOLDER",
        "Only placeholder accounts may have children",
        { parentId },
      );
    }
    if (parent.type !== type) {
      return err("ACCOUNT_TYPE_MISMATCH", "Child type must match parent type");
    }
  }

  if (siblingNameTaken(book, parentId, name, account.id)) {
    return err("ACCOUNT_NAME_DUPLICATE", "Account name already used among siblings", {
      name,
      parentId,
    });
  }

  const next = cloneBook(book);
  const index = next.accounts.findIndex((item) => item.id === account.id);
  next.accounts[index] = {
    ...next.accounts[index],
    name,
    parentId,
    isPlaceholder,
    type,
    currency,
    updatedAt: now,
  };
  return ok(next);
}

export function deleteAccount(book: Book, id: string, now: string): Result<Book> {
  const account = findAccount(book, id);
  if (!account) {
    return err("ACCOUNT_NOT_FOUND", "Account not found", { id });
  }
  if (hasChildren(book, id)) {
    return err("ACCOUNT_HAS_CHILDREN", "Cannot delete account with children", { id });
  }
  if (hasPostings(book, id)) {
    return err("ACCOUNT_HAS_POSTINGS", "Cannot delete account with postings", { id });
  }
  const next = cloneBook(book);
  next.accounts = next.accounts.filter((item) => item.id !== id);
  addTombstone(next, "account", id, account, now);
  // A limit without its account, or a rule that posts to a deleted account, is
  // meaningless — both go with the account.
  const removedBudgets = next.budgets.filter((budget) => budget.accountId === id);
  next.budgets = next.budgets.filter((budget) => budget.accountId !== id);
  for (const budget of removedBudgets) {
    addTombstone(next, "budget", budgetKeyOf(budget), budget, now);
  }
  const touchesAccount = (rule: (typeof next.recurrences)[number]) =>
    rule.fromAccountId === id || rule.lines.some((line) => line.toAccountId === id);
  const removedRecurrences = next.recurrences.filter(touchesAccount);
  next.recurrences = next.recurrences.filter((rule) => !touchesAccount(rule));
  for (const rule of removedRecurrences) {
    addTombstone(next, "recurrence", rule.id, rule, now);
  }
  return ok(next);
}
