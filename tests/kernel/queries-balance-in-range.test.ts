import { describe, expect, it } from "vitest";
import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { balanceInRange } from "../../src/kernel/queries";
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

/** Cash → target on the given date; `amount` in minor units. */
function spend(book: Book, cash: string, target: string, date: string, amount: number): Book {
  return unwrap(
    postEntry(book, {
      date,
      description: `spend ${date}`,
      postings: [
        { accountId: target, side: "debit", amount },
        { accountId: cash, side: "credit", amount },
      ],
    }, NOW),
  );
}

/** Source → cash on the given date (income, or a refund on an expense). */
function receive(book: Book, cash: string, source: string, date: string, amount: number): Book {
  return unwrap(
    postEntry(book, {
      date,
      description: `receive ${date}`,
      postings: [
        { accountId: cash, side: "debit", amount },
        { accountId: source, side: "credit", amount },
      ],
    }, NOW),
  );
}

function bookWithCashAndFood() {
  let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
  book = leaf(book, "Cash", "asset");
  book = leaf(book, "Food", "expense");
  return { book, cash: book.accounts[0].id, food: book.accounts[1].id };
}

describe("balanceInRange", () => {
  it("sums only the entries inside the range, debit-positive for an expense leaf", () => {
    let { book, cash, food } = bookWithCashAndFood();
    book = spend(book, cash, food, "2026-07-31", 1000);
    book = spend(book, cash, food, "2026-08-10", 3000);
    book = spend(book, cash, food, "2026-09-01", 5000);
    expect(unwrap(balanceInRange(book, food, AUGUST))).toEqual({
      kind: "leaf",
      currency: "ILS",
      amount: 3000,
    });
  });

  it("is credit-positive for an income leaf", () => {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    book = leaf(book, "Cash", "asset");
    book = leaf(book, "Salary", "income");
    const cash = book.accounts[0].id;
    const salary = book.accounts[1].id;
    book = receive(book, cash, salary, "2026-08-15", 500000);
    expect(unwrap(balanceInRange(book, salary, AUGUST))).toEqual({
      kind: "leaf",
      currency: "ILS",
      amount: 500000,
    });
  });

  it("includes both range bounds", () => {
    let { book, cash, food } = bookWithCashAndFood();
    book = spend(book, cash, food, "2026-08-01", 100);
    book = spend(book, cash, food, "2026-08-31", 200);
    expect(unwrap(balanceInRange(book, food, AUGUST))).toMatchObject({ amount: 300 });
  });

  it("does not clamp a refund month to zero", () => {
    let { book, cash, food } = bookWithCashAndFood();
    book = spend(book, cash, food, "2026-08-05", 1000);
    book = receive(book, cash, food, "2026-08-20", 2500);
    expect(unwrap(balanceInRange(book, food, AUGUST))).toMatchObject({ amount: -1500 });
  });

  it("returns zero for a leaf with nothing in range", () => {
    let { book, cash, food } = bookWithCashAndFood();
    book = spend(book, cash, food, "2026-07-01", 1000);
    expect(unwrap(balanceInRange(book, food, AUGUST))).toEqual({
      kind: "leaf",
      currency: "ILS",
      amount: 0,
    });
  });

  it("buckets a group by currency and drops currencies that net to zero", () => {
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
    const food = book.accounts[4].id;
    const travel = book.accounts[5].id;
    const books = book.accounts[6].id;

    book = spend(book, cashIls, food, "2026-08-03", 4000);
    book = spend(book, cashUsd, travel, "2026-08-04", 9000);
    book = spend(book, cashEur, books, "2026-08-05", 700);
    book = receive(book, cashEur, books, "2026-08-06", 700); // EUR nets to zero
    book = spend(book, cashIls, food, "2026-09-01", 99999); // outside the range

    expect(unwrap(balanceInRange(book, expenses, AUGUST))).toEqual({
      kind: "placeholder",
      balances: { ILS: 4000, USD: 9000 },
    });
  });

  it("returns an empty map for a group with nothing in range", () => {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    book = group(book, "Expenses", "expense");
    const expenses = book.accounts[0].id;
    expect(unwrap(balanceInRange(book, expenses, AUGUST))).toEqual({
      kind: "placeholder",
      balances: {},
    });
  });

  it("rejects invalid dates and unknown accounts", () => {
    const { book, food } = bookWithCashAndFood();
    expect(unwrapErr(balanceInRange(book, food, { from: "2026-13-01", to: "2026-08-31" })).code)
      .toBe("ENTRY_DATE_INVALID");
    expect(unwrapErr(balanceInRange(book, food, { from: "2026-08-01", to: "nope" })).code)
      .toBe("ENTRY_DATE_INVALID");
    expect(unwrapErr(balanceInRange(book, "missing", AUGUST)).code).toBe("ACCOUNT_NOT_FOUND");
  });
});
