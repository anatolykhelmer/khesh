import {
  cloneBook,
  findAccount,
  hasChildren,
  hasPostings,
  siblingNameTaken,
  wouldCreateCycle,
} from "./book-utils";
import { isCurrencyCode } from "./currency";
import { createId } from "./ids";
import { err, ok, type Result } from "./result";
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
  };
  return ok(next);
}

export function deleteAccount(book: Book, id: string): Result<Book> {
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
  return ok(next);
}
