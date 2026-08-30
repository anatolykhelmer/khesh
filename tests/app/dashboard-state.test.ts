import { describe, expect, it } from "vitest";
import { createAccount } from "../../src/kernel/accounts";
import { setBudget } from "../../src/kernel/budgets";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { budgetReport, periodTotals } from "../../src/kernel/queries";
import type { BudgetReport } from "../../src/kernel/queries";
import type { AccountType, Book } from "../../src/kernel/types";
import { heroState } from "../../src/app/dashboard-state";
import { unwrap } from "../helpers";

const MONTH = { from: "2026-08-01", to: "2026-08-31" };

function add(
  book: Book,
  input: {
    parentId: string | null;
    name: string;
    type: AccountType;
    currency: string;
    isPlaceholder: boolean;
  },
): { book: Book; id: string } {
  const next = unwrap(createAccount(book, input));
  return { book: next, id: next.accounts[next.accounts.length - 1].id };
}

/** Cash ILS, and Expenses > Food > Groceries, all ILS. */
function fixture() {
  let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
  const cash = add(book, {
    parentId: null, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false,
  });
  book = cash.book;
  const expenses = add(book, {
    parentId: null, name: "Expenses", type: "expense", currency: "ILS", isPlaceholder: true,
  });
  book = expenses.book;
  const food = add(book, {
    parentId: expenses.id, name: "Food", type: "expense", currency: "ILS", isPlaceholder: true,
  });
  book = food.book;
  const groceries = add(book, {
    parentId: food.id, name: "Groceries", type: "expense", currency: "ILS", isPlaceholder: false,
  });
  book = groceries.book;
  return { book, cash: cash.id, expenses: expenses.id, food: food.id, groceries: groceries.id };
}

function spend(book: Book, from: string, to: string, amount: number): Book {
  return unwrap(
    postEntry(book, {
      date: "2026-08-10",
      description: "shopping",
      postings: [
        { accountId: to, side: "debit", amount },
        { accountId: from, side: "credit", amount },
      ],
    }),
  );
}

function hero(book: Book) {
  return heroState(
    book,
    unwrap(periodTotals(book, MONTH)),
    unwrap(budgetReport(book, "month", MONTH)),
  );
}

describe("heroState", () => {
  it("is empty while the book has no entries at all", () => {
    const { book } = fixture();
    expect(hero(book)).toEqual({ kind: "empty" });
  });

  it("stays empty-free once an entry exists, even in a month with no spending", () => {
    const f = fixture();
    // The entry is in July; August is the period under test and totals zero.
    const book = unwrap(
      postEntry(f.book, {
        date: "2026-07-10",
        description: "shopping",
        postings: [
          { accountId: f.groceries, side: "debit", amount: 5000 },
          { accountId: f.cash, side: "credit", amount: 5000 },
        ],
      }),
    );
    expect(hero(book)).toEqual({ kind: "unbudgeted", spent: 0 });
  });

  it("reports unbudgeted spending when no limit is set", () => {
    const f = fixture();
    const book = spend(f.book, f.cash, f.groceries, 9520);
    expect(hero(book)).toEqual({ kind: "unbudgeted", spent: 9520 });
  });

  it("reports progress against a limit", () => {
    const f = fixture();
    let book = spend(f.book, f.cash, f.groceries, 9520);
    book = unwrap(
      setBudget(book, { accountId: f.food, currency: "ILS", period: "month", limit: 12000 }),
    );
    expect(hero(book)).toEqual({
      kind: "budgeted",
      spent: 9520,
      limit: 12000,
      pct: 79,
      over: false,
    });
  });

  it("clamps the bar at 100 while still flagging the overrun", () => {
    const f = fixture();
    let book = spend(f.book, f.cash, f.groceries, 14000);
    book = unwrap(
      setBudget(book, { accountId: f.food, currency: "ILS", period: "month", limit: 10000 }),
    );
    expect(hero(book)).toEqual({
      kind: "budgeted",
      spent: 14000,
      limit: 10000,
      pct: 100,
      over: true,
    });
  });

  it("does not divide by a zero limit", () => {
    const f = fixture();
    const book = spend(f.book, f.cash, f.groceries, 500);
    // The kernel refuses a non-positive limit (budgets.ts, validate.ts), so this report
    // cannot come from a valid book. heroState takes a report as a parameter, though, and
    // cannot validate it — the guard exists so a degenerate one renders 100% rather than
    // "NaN%" in the user's face.
    const report: BudgetReport = {
      period: "month",
      rows: [
        {
          accountId: f.food,
          name: "Food",
          path: "Expenses:Food",
          isGroup: true,
          currency: "ILS",
          limit: 0,
          spent: 500,
          remaining: 0,
        },
      ],
      unbudgeted: {},
    };
    expect(heroState(book, unwrap(periodTotals(book, MONTH)), report)).toEqual({
      kind: "budgeted",
      spent: 500,
      limit: 0,
      pct: 100,
      over: true,
    });
  });

  it("shows a zero-limit month with no spending as 100%, not NaN", () => {
    const f = fixture();
    const book = spend(f.book, f.cash, f.groceries, 500);
    const report: BudgetReport = {
      period: "month",
      rows: [
        {
          accountId: f.food,
          name: "Food",
          path: "Expenses:Food",
          isGroup: true,
          currency: "ILS",
          limit: 0,
          spent: 0,
          remaining: 0,
        },
      ],
      unbudgeted: {},
    };
    const result = heroState(book, { ILS: { income: 0, expense: 0 } }, report);
    expect(result).toEqual({ kind: "budgeted", spent: 0, limit: 0, pct: 100, over: false });
  });

  it("counts a nested limit once, not twice", () => {
    const f = fixture();
    let book = spend(f.book, f.cash, f.groceries, 3000);
    // A limit on the group and another on a descendant leaf. Summing both would
    // report a 16,000 budget where the household only planned 10,000.
    book = unwrap(
      setBudget(book, { accountId: f.food, currency: "ILS", period: "month", limit: 10000 }),
    );
    book = unwrap(
      setBudget(book, { accountId: f.groceries, currency: "ILS", period: "month", limit: 6000 }),
    );
    const result = hero(book);
    expect(result).toMatchObject({ kind: "budgeted", limit: 10000 });
  });

  it("ignores limits in a currency other than the home currency", () => {
    const f = fixture();
    let book = f.book;
    const usdCash = add(book, {
      parentId: null, name: "USD Cash", type: "asset", currency: "USD", isPlaceholder: false,
    });
    book = usdCash.book;
    const trips = add(book, {
      parentId: f.expenses, name: "Trips", type: "expense", currency: "USD", isPlaceholder: false,
    });
    book = trips.book;
    book = spend(book, usdCash.id, trips.id, 4000);
    book = unwrap(
      setBudget(book, { accountId: trips.id, currency: "USD", period: "month", limit: 5000 }),
    );
    // Only a USD limit exists, so the ILS hero has no denominator.
    expect(hero(book)).toEqual({ kind: "unbudgeted", spent: 0 });
  });
});
