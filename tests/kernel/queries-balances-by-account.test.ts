import { describe, expect, it } from "vitest";
import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import {
  balance,
  balanceAsOf,
  balanceInRange,
  balancesByAccount,
} from "../../src/kernel/queries";
import type { AccountType, Book, CurrencyCode } from "../../src/kernel/types";
import { NOW, unwrap, unwrapErr } from "../helpers";

const AUGUST = { from: "2026-08-01", to: "2026-08-31" };

function leaf(
  book: Book,
  name: string,
  type: AccountType,
  currency: CurrencyCode = "ILS",
  parentId: string | null = null,
): Book {
  return unwrap(
    createAccount(book, { parentId, name, type, currency, isPlaceholder: false }, NOW),
  );
}

function group(book: Book, name: string, type: AccountType): Book {
  return unwrap(
    createAccount(book, { parentId: null, name, type, currency: "ILS", isPlaceholder: true }, NOW),
  );
}

function spend(book: Book, cash: string, target: string, date: string, amount: number): Book {
  return unwrap(
    postEntry(
      book,
      {
        date,
        description: `spend ${date}`,
        postings: [
          { accountId: target, side: "debit", amount },
          { accountId: cash, side: "credit", amount },
        ],
      },
      NOW,
    ),
  );
}

function receive(book: Book, cash: string, source: string, date: string, amount: number): Book {
  return unwrap(
    postEntry(
      book,
      {
        date,
        description: `receive ${date}`,
        postings: [
          { accountId: cash, side: "debit", amount },
          { accountId: source, side: "credit", amount },
        ],
      },
      NOW,
    ),
  );
}

/** Three currencies, a group whose EUR nets to zero in August, a leaf with no postings
 * at all, and entries on both sides of the window — every branch of the balance shape. */
function fixture() {
  let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
  book = leaf(book, "Cash ILS", "asset", "ILS");
  book = leaf(book, "Cash USD", "asset", "USD");
  book = leaf(book, "Cash EUR", "asset", "EUR");
  book = group(book, "Expenses", "expense");
  const cashIls = book.accounts[0].id;
  const cashUsd = book.accounts[1].id;
  const cashEur = book.accounts[2].id;
  const expenses = book.accounts[3].id;
  book = leaf(book, "Food", "expense", "ILS", expenses);
  book = leaf(book, "Travel", "expense", "USD", expenses);
  book = leaf(book, "Books", "expense", "EUR", expenses);
  book = leaf(book, "Rent", "expense", "ILS", expenses);
  const food = book.accounts[4].id;
  const travel = book.accounts[5].id;
  const books = book.accounts[6].id;
  const rent = book.accounts[7].id;

  book = spend(book, cashIls, food, "2026-07-20", 1000);
  book = spend(book, cashIls, food, "2026-08-03", 4000);
  book = spend(book, cashUsd, travel, "2026-08-04", 9000);
  book = spend(book, cashEur, books, "2026-08-05", 700);
  book = receive(book, cashEur, books, "2026-08-06", 700);
  book = spend(book, cashIls, food, "2026-09-01", 99999);

  return { book, expenses, rent };
}

describe("balancesByAccount", () => {
  it("equals balanceInRange for every account inside a range", () => {
    const { book } = fixture();
    const all = unwrap(balancesByAccount(book, AUGUST));
    for (const account of book.accounts) {
      expect(all.get(account.id), account.name).toEqual(
        unwrap(balanceInRange(book, account.id, AUGUST)),
      );
    }
  });

  it("equals balance with no bounds and balanceAsOf with only `to`", () => {
    const { book } = fixture();
    const running = unwrap(balancesByAccount(book));
    const asOf = unwrap(balancesByAccount(book, { to: "2026-08-04" }));
    for (const account of book.accounts) {
      expect(running.get(account.id), account.name).toEqual(unwrap(balance(book, account.id)));
      expect(asOf.get(account.id), account.name).toEqual(
        unwrap(balanceAsOf(book, account.id, "2026-08-04")),
      );
    }
  });

  it("holds every account — groups and a leaf with no postings included", () => {
    const { book, expenses, rent } = fixture();
    const all = unwrap(balancesByAccount(book, AUGUST));
    expect(all.size).toBe(book.accounts.length);
    expect(all.get(rent)).toEqual({ kind: "leaf", currency: "ILS", amount: 0 });
    expect(all.get(expenses)).toEqual({
      kind: "placeholder",
      balances: { ILS: 4000, USD: 9000 },
    });
  });

  it("rejects a malformed bound and treats an inverted range as empty", () => {
    const { book, expenses } = fixture();
    expect(unwrapErr(balancesByAccount(book, { from: "2026-13-01" })).code).toBe(
      "ENTRY_DATE_INVALID",
    );
    expect(unwrapErr(balancesByAccount(book, { to: "nope" })).code).toBe("ENTRY_DATE_INVALID");
    const inverted = unwrap(balancesByAccount(book, { from: "2026-08-31", to: "2026-08-01" }));
    expect(inverted.get(expenses)).toEqual({ kind: "placeholder", balances: {} });
  });
});
