import { cloneBook, findAccount, siblingNameTaken } from "./book-utils";
import { isCalendarDate } from "./dates";
import { validatePostings } from "./entry-validation";
import { deleteEntry } from "./journal";
import { err, ok, type Result } from "./result";
import type { Account, Book, MinorUnits, PostingSide } from "./types";

const OB_PARENT_ID = "sys:ob";
const OB_PARENT_NAME = "Opening Balances";

function obLeafId(currency: string): string {
  return `sys:ob:${currency}`;
}

export function isOpeningBalancesGroupId(id: string): boolean {
  return id === OB_PARENT_ID;
}

export function isOpeningBalancesLeafId(id: string): boolean {
  return id.startsWith("sys:ob:");
}

function isSystemObId(id: string): boolean {
  return isOpeningBalancesGroupId(id) || isOpeningBalancesLeafId(id);
}

function obNameCollision(book: Book, parentId: string | null, name: string): boolean {
  return book.accounts.some(
    (account) =>
      account.parentId === parentId && account.name === name && !isSystemObId(account.id),
  );
}

function targetSide(type: Account["type"]): PostingSide {
  return type === "asset" || type === "expense" ? "debit" : "credit";
}

function opposite(side: PostingSide): PostingSide {
  return side === "debit" ? "credit" : "debit";
}

function ensureObAccounts(book: Book, currency: string, groupName: string): Result<void> {
  if (!book.accounts.some((account) => account.id === OB_PARENT_ID)) {
    if (obNameCollision(book, null, groupName)) {
      return err(
        "ACCOUNT_NAME_DUPLICATE",
        "Cannot create Opening Balances system account: name already used among root accounts",
        { name: groupName },
      );
    }
    book.accounts.push({
      id: OB_PARENT_ID,
      parentId: null,
      name: groupName,
      type: "equity",
      currency: book.homeCurrency,
      isPlaceholder: true,
    });
  }

  if (obNameCollision(book, OB_PARENT_ID, currency)) {
    return err(
      "ACCOUNT_NAME_DUPLICATE",
      `Cannot create opening balance account for ${currency}: name already used among siblings`,
      { name: currency, parentId: OB_PARENT_ID },
    );
  }

  const leafId = obLeafId(currency);
  if (!book.accounts.some((account) => account.id === leafId)) {
    if (siblingNameTaken(book, OB_PARENT_ID, currency, leafId)) {
      return err(
        "ACCOUNT_NAME_DUPLICATE",
        `Cannot create opening balance account for ${currency}: name already used among siblings`,
        { name: currency, parentId: OB_PARENT_ID },
      );
    }
    book.accounts.push({
      id: leafId,
      parentId: OB_PARENT_ID,
      name: currency,
      type: "equity",
      currency,
      isPlaceholder: false,
    });
  }

  return ok(undefined);
}

export function recordOpeningBalance(
  book: Book,
  input: { accountId: string; amount: MinorUnits; date: string; groupName?: string },
): Result<Book> {
  if (!isCalendarDate(input.date)) {
    return err("ENTRY_DATE_INVALID", `Invalid date ${input.date}`, { date: input.date });
  }
  if (!Number.isInteger(input.amount) || input.amount < 0 || !Number.isFinite(input.amount)) {
    return err("ENTRY_AMOUNT_INVALID", "Opening amount must be an integer >= 0", {
      amount: input.amount,
    });
  }

  if (isSystemObId(input.accountId)) {
    return err("ACCOUNT_IS_SYSTEM", "Cannot set opening balance on a system OB account", {
      accountId: input.accountId,
    });
  }

  const target = findAccount(book, input.accountId);
  if (!target) {
    return err("ACCOUNT_NOT_FOUND", "Account not found", { accountId: input.accountId });
  }
  if (target.isPlaceholder) {
    return err("ACCOUNT_IS_PLACEHOLDER", "Cannot set opening balance on a placeholder", {
      accountId: input.accountId,
    });
  }

  const entryId = `opening:${input.accountId}`;

  if (input.amount === 0) {
    if (!book.journal.some((entry) => entry.id === entryId)) {
      return ok(cloneBook(book));
    }
    return deleteEntry(book, entryId);
  }

  const next = cloneBook(book);
  const obAccounts = ensureObAccounts(next, target.currency, input.groupName ?? OB_PARENT_NAME);
  if (!obAccounts.ok) return obAccounts;
  const side = targetSide(target.type);
  const postings = [
    { accountId: target.id, side, amount: input.amount },
    { accountId: obLeafId(target.currency), side: opposite(side), amount: input.amount },
  ];
  const validated = validatePostings(next, postings, "opening", undefined);
  if (!validated.ok) return validated;

  const entry = {
    id: entryId,
    date: input.date,
    description: "",
    kind: "opening" as const,
    postings,
  };
  const index = next.journal.findIndex((item) => item.id === entryId);
  if (index === -1) next.journal.push(entry);
  else next.journal[index] = entry;
  return ok(next);
}
