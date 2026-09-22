import { describe, expect, it } from "vitest";
import { createAccount } from "../../src/kernel/accounts";
import { postEntry } from "../../src/kernel/journal";
import { balanceInRange, turnoverInRange } from "../../src/kernel/queries";
import type { Book, CurrencyCode } from "../../src/kernel/types";
import { NOW, unwrap, unwrapErr } from "../helpers";
import { accountNamed, realBook, ROOT, type RootType } from "../helpers/book";

const AUGUST = { from: "2026-08-01", to: "2026-08-31" };

function leaf(
  book: Book,
  name: string,
  type: RootType,
  currency: CurrencyCode = "ILS",
  parentId: string = ROOT[type],
): Book {
  return unwrap(
    createAccount(book, { parentId, name, type, currency, isPlaceholder: false }, NOW),
  );
}

function group(book: Book, name: string, type: RootType): Book {
  return unwrap(
    createAccount(book, { parentId: ROOT[type], name, type, currency: "ILS", isPlaceholder: true }, NOW),
  );
}

/** `from` → `to` on the given date: debit `to`, credit `from`; `amount` in minor units. */
function move(book: Book, from: string, to: string, date: string, amount: number): Book {
  return unwrap(
    postEntry(book, {
      date,
      description: `move ${date}`,
      postings: [
        { accountId: to, side: "debit", amount },
        { accountId: from, side: "credit", amount },
      ],
    }, NOW),
  );
}

function bookWithCashSalaryFood() {
  let book = realBook();
  book = leaf(book, "Cash", "asset");
  book = leaf(book, "Salary", "income");
  book = leaf(book, "Food", "expense");
  return {
    book,
    cash: accountNamed(book, "Cash").id,
    salary: accountNamed(book, "Salary").id,
    food: accountNamed(book, "Food").id,
  };
}

describe("turnoverInRange on a leaf", () => {
  it("splits an asset's debits and credits and nets them the way balanceInRange does", () => {
    let { book, cash, salary, food } = bookWithCashSalaryFood();
    book = move(book, salary, cash, "2026-08-01", 500000);
    book = move(book, cash, food, "2026-08-10", 3000);
    book = move(book, cash, food, "2026-09-01", 5000); // outside the range
    const result = unwrap(turnoverInRange(book, cash, AUGUST));
    expect(result).toEqual({
      kind: "leaf",
      currency: "ILS",
      turnover: { inflow: 500000, outflow: 3000, net: 497000 },
    });
    expect(unwrap(balanceInRange(book, cash, AUGUST))).toMatchObject({ amount: 497000 });
  });

  it("counts a card charge as outflow, a repayment as inflow, and grows net with the debt", () => {
    let { book, cash, food } = bookWithCashSalaryFood();
    book = leaf(book, "Card", "liability");
    const card = accountNamed(book, "Card").id;
    book = move(book, card, food, "2026-08-03", 4000); // charge: credit the card
    book = move(book, cash, card, "2026-08-20", 1500); // repayment: debit the card
    expect(unwrap(turnoverInRange(book, card, AUGUST))).toEqual({
      kind: "leaf",
      currency: "ILS",
      turnover: { inflow: 1500, outflow: 4000, net: 2500 },
    });
  });

  it("keeps a refund on an expense as outflow, so net is below inflow", () => {
    let { book, cash, food } = bookWithCashSalaryFood();
    book = move(book, cash, food, "2026-08-05", 1000);
    book = move(book, food, cash, "2026-08-20", 2500); // refund: credit the expense
    expect(unwrap(turnoverInRange(book, food, AUGUST))).toEqual({
      kind: "leaf",
      currency: "ILS",
      turnover: { inflow: 1000, outflow: 2500, net: -1500 },
    });
  });

  it("is credit-positive for income", () => {
    let { book, cash, salary } = bookWithCashSalaryFood();
    book = move(book, salary, cash, "2026-08-15", 500000);
    expect(unwrap(turnoverInRange(book, salary, AUGUST))).toMatchObject({
      turnover: { inflow: 0, outflow: 500000, net: 500000 },
    });
  });

  it("returns all zeros for a leaf with nothing in range", () => {
    let { book, cash, food } = bookWithCashSalaryFood();
    book = move(book, cash, food, "2026-07-01", 1000);
    expect(unwrap(turnoverInRange(book, food, AUGUST))).toEqual({
      kind: "leaf",
      currency: "ILS",
      turnover: { inflow: 0, outflow: 0, net: 0 },
    });
  });

  it("includes both bounds and excludes the day before", () => {
    let { book, cash, food } = bookWithCashSalaryFood();
    book = move(book, cash, food, "2026-07-31", 1);
    book = move(book, cash, food, "2026-08-01", 100);
    book = move(book, cash, food, "2026-08-31", 200);
    expect(unwrap(turnoverInRange(book, food, AUGUST))).toMatchObject({
      turnover: { inflow: 300, outflow: 0, net: 300 },
    });
  });

  it("treats {} as all time and { to } as up to a date", () => {
    let { book, cash, food } = bookWithCashSalaryFood();
    book = move(book, cash, food, "2025-01-01", 10);
    book = move(book, cash, food, "2026-08-10", 20);
    book = move(book, cash, food, "2027-01-01", 40);
    expect(unwrap(turnoverInRange(book, food, {})).kind).toBe("leaf");
    expect(unwrap(turnoverInRange(book, food, {}))).toMatchObject({ turnover: { inflow: 70 } });
    expect(unwrap(turnoverInRange(book, food))).toMatchObject({ turnover: { inflow: 70 } });
    expect(unwrap(turnoverInRange(book, food, { to: "2026-08-31" }))).toMatchObject({
      turnover: { inflow: 30 },
    });
  });
});

describe("turnoverInRange on a group", () => {
  function bookWithExpenseGroup() {
    let book = realBook();
    book = leaf(book, "Cash ILS", "asset", "ILS");
    book = leaf(book, "Cash USD", "asset", "USD");
    book = leaf(book, "Cash EUR", "asset", "EUR");
    const expenses = ROOT.expense;
    book = leaf(book, "Food", "expense", "ILS", expenses);
    book = leaf(book, "Travel", "expense", "USD", expenses);
    book = leaf(book, "Books", "expense", "EUR", expenses);
    return {
      book,
      cashIls: accountNamed(book, "Cash ILS").id,
      cashUsd: accountNamed(book, "Cash USD").id,
      cashEur: accountNamed(book, "Cash EUR").id,
      expenses,
      food: accountNamed(book, "Food").id,
      travel: accountNamed(book, "Travel").id,
      books: accountNamed(book, "Books").id,
    };
  }

  it("buckets descendants by currency, summing each leaf's turnover", () => {
    const f = bookWithExpenseGroup();
    let book = f.book;
    book = move(book, f.cashIls, f.food, "2026-08-03", 4000);
    book = move(book, f.cashUsd, f.travel, "2026-08-04", 9000);
    book = move(book, f.cashIls, f.food, "2026-09-01", 99999); // outside the range
    expect(unwrap(turnoverInRange(book, f.expenses, AUGUST))).toEqual({
      kind: "placeholder",
      byCurrency: {
        ILS: { inflow: 4000, outflow: 0, net: 4000 },
        USD: { inflow: 9000, outflow: 0, net: 9000 },
      },
    });
  });

  it("keeps a currency that moved and netted to zero, which balanceInRange drops", () => {
    const f = bookWithExpenseGroup();
    let book = f.book;
    book = move(book, f.cashEur, f.books, "2026-08-05", 700);
    book = move(book, f.books, f.cashEur, "2026-08-06", 700);
    expect(unwrap(turnoverInRange(book, f.expenses, AUGUST))).toEqual({
      kind: "placeholder",
      byCurrency: { EUR: { inflow: 700, outflow: 700, net: 0 } },
    });
    expect(unwrap(balanceInRange(book, f.expenses, AUGUST))).toEqual({
      kind: "placeholder",
      balances: {},
    });
  });

  it("returns an empty record for a group with nothing in range", () => {
    const f = bookWithExpenseGroup();
    expect(unwrap(turnoverInRange(f.book, f.expenses, AUGUST))).toEqual({
      kind: "placeholder",
      byCurrency: {},
    });
  });
});

describe("turnoverInRange bounds and errors", () => {
  it("treats an inverted range as empty, not as an error", () => {
    let { book, cash, food } = bookWithCashSalaryFood();
    book = move(book, cash, food, "2026-08-10", 1000);
    expect(
      unwrap(turnoverInRange(book, food, { from: "2026-08-31", to: "2026-08-01" })),
    ).toMatchObject({ turnover: { inflow: 0, outflow: 0, net: 0 } });
  });

  it("rejects malformed bounds and unknown accounts", () => {
    const { book, food } = bookWithCashSalaryFood();
    expect(unwrapErr(turnoverInRange(book, food, { from: "2026-13-01" })).code).toBe(
      "ENTRY_DATE_INVALID",
    );
    expect(unwrapErr(turnoverInRange(book, food, { to: "nope" })).code).toBe(
      "ENTRY_DATE_INVALID",
    );
    expect(unwrapErr(turnoverInRange(book, "missing", AUGUST)).code).toBe("ACCOUNT_NOT_FOUND");
  });
});
