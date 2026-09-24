import {
  cloneBook,
  findAccount,
  hasBudgets,
  hasChildren,
  hasPostings,
  recurrencesReferencing,
  replaceIfChanged,
  siblingNameTaken,
  wouldCreateCycle,
} from "./book-utils";
import { isCurrencyCode } from "./currency";
import { createId } from "./ids";
import { err, ok, type Result } from "./result";
import { addTombstone, budgetKeyOf, clearTombstone } from "./tombstones";
import type { AccountType, Book, CurrencyCode } from "./types";

export function createAccount(
  book: Book,
  input: {
    id?: string;
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
  if (input.id !== undefined && book.accounts.some((account) => account.id === input.id)) {
    return err("ACCOUNT_ID_DUPLICATE", `Duplicate account id ${input.id}`, { id: input.id });
  }
  if (!isCurrencyCode(input.currency)) {
    return err("INVALID_CURRENCY_CODE", `Invalid currency ${input.currency}`, {
      currency: input.currency,
    });
  }
  if (input.parentId === null && !input.isPlaceholder) {
    return err("ACCOUNT_ROOT_NOT_PLACEHOLDER", "A top-level account must be a placeholder");
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
    id: input.id ?? createId(),
    parentId: input.parentId,
    name,
    type: input.type,
    currency: input.currency,
    isPlaceholder: input.isPlaceholder,
    updatedAt: now,
  });
  // A re-created record must not leave its own tombstone behind — that shadowing is
  // exactly what validateBook rejects ("Tombstone shadows a live record"). Only reachable
  // for an explicit id; a fresh ulid has never been deleted.
  if (input.id !== undefined) clearTombstone(next, "account", input.id);
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
    // A limit only makes sense on an expense account (ACCOUNT_TYPE_MISMATCH in
    // validateBook, and rung 6 of the merge ladder drops such a limit outright).
    // Retyping an account is not destructive on its face, so — by the same argument
    // the placeholder guard below makes for recurrences — it must refuse rather than
    // silently orphan the limit into a book that will not load.
    if (type !== "expense" && hasBudgets(book, account.id)) {
      return err("ACCOUNT_HAS_BUDGETS", "Cannot change type away from expense while a budget covers it", {
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

  // An account's level is fixed for life. It reaches the top level only by being created
  // there — createHousehold's roots, recordOpeningBalance's Opening Balances group — or by
  // the merge ladder's rung 2 detaching a cycle member; no edit moves it up or down. A move
  // either way lets one device hold the account at the top level while another holds it
  // under a parent, turns it into a leaf and posts to it. Whenever the top-level copy is
  // the newer one, the merge meets a top-level account with postings, which rung 3 cannot
  // repair: there is no parent to give it, and forcing it off placeholder would leave a
  // top-level leaf, which validateBook rejects. The edit form never offers either move.
  // Checked after the parent itself, so a move that is wrong on its own terms — a cycle, a
  // leaf or mistyped parent — is still refused for that.
  if ((parentId === null) !== (account.parentId === null)) {
    return err("ACCOUNT_PARENT_INVALID", "An account cannot move between the top level and a parent", {
      id: account.id,
    });
  }
  if (parentId === null && !isPlaceholder) {
    return err("ACCOUNT_ROOT_NOT_PLACEHOLDER", "A top-level account must be a placeholder", {
      id: account.id,
    });
  }

  if (siblingNameTaken(book, parentId, name, account.id)) {
    return err("ACCOUNT_NAME_DUPLICATE", "Account name already used among siblings", {
      name,
      parentId,
    });
  }

  const index = book.accounts.findIndex((item) => item.id === account.id);
  return ok(
    replaceIfChanged(
      book,
      "accounts",
      index,
      { ...account, name, parentId, isPlaceholder, type, currency },
      now,
    ),
  );
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
