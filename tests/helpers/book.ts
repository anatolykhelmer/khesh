import { createBook } from "../../src/kernel/create-book";
import type { Account, AccountType, Book, CurrencyCode } from "../../src/kernel/types";
// Explicit extension: from inside `tests/helpers/`, `../helpers` names both this directory
// and `tests/helpers.ts`, and the file is the one meant.
import { NOW, unwrap } from "../helpers.ts";

export type RootType = Exclude<AccountType, "equity">;
export type RootIds = Readonly<Record<RootType, string>>;

/**
 * The four category roots, at ids a fixture can write down. A book the app produces always
 * has exactly these at the top level and everything else nested under them
 * (`createHousehold`; `scripts/demo-book.ts` builds the same shape for the screenshots).
 *
 * Fixed rather than minted because the raw-literal fixtures reference accounts by readable
 * id (`{ id: "bank", parentId: ROOT.asset, ... }`). The prefix is deliberately neither
 * `sys:` — hidden system accounts — nor `seed:`, BL-048's app-minted ids.
 */
export const ROOT: RootIds = {
  asset: "root:asset",
  liability: "root:liability",
  income: "root:income",
  expense: "root:expense",
};

const ROOT_TYPES: readonly RootType[] = ["asset", "liability", "income", "expense"];

const ROOT_NAMES: Readonly<Record<RootType, string>> = {
  asset: "Assets",
  liability: "Liabilities",
  income: "Income",
  expense: "Expenses",
};

/** The four root records. `ids` exists for a second device's book: same names, its own ids. */
export function rootAccounts(
  homeCurrency: CurrencyCode = "ILS",
  at: string = NOW,
  ids: RootIds = ROOT,
): Account[] {
  return ROOT_TYPES.map((type) => ({
    id: ids[type],
    parentId: null,
    name: ROOT_NAMES[type],
    type,
    currency: homeCurrency,
    isPlaceholder: true,
    updatedAt: at,
  }));
}

/** A book shaped the way the app produces one: the four roots and nothing else yet. */
export function realBook(
  homeCurrency: CurrencyCode = "ILS",
  at: string = NOW,
  ids: RootIds = ROOT,
): Book {
  const book = unwrap(createBook({ name: "Home", homeCurrency }, at));
  book.accounts = rootAccounts(homeCurrency, at, ids);
  return book;
}

/** The replacement for `book.accounts[2]`: the one account with this name. */
export function accountNamed(book: Book, name: string): Account {
  const matches = book.accounts.filter((account) => account.name === name);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one account named ${JSON.stringify(name)}, found ${matches.length}`);
  }
  return matches[0];
}
