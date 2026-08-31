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

/** Cash ILS, and Expenses > Food > Groceries, plus a Rent leaf no limit ever covers. */
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
  const rent = add(book, {
    parentId: expenses.id, name: "Rent", type: "expense", currency: "ILS", isPlaceholder: false,
  });
  book = rent.book;
  return {
    book,
    cash: cash.id,
    expenses: expenses.id,
    food: food.id,
    groceries: groceries.id,
    rent: rent.id,
  };
}

/**
 * A wider tree for Item 1's nested-limit test:
 *
 * Expenses (group, no limit)
 * ├── Food (group)        limit 1000
 * │   ├── Groceries       limit 600
 * │   └── Restaurants     no limit
 * ├── Car (group)         limit 2000
 * │   ├── Fuel            limit 1200
 * │   └── Repairs         no limit
 * └── Rent                no limit
 */
function fixtureWide() {
  const f = fixture();
  let book = f.book;
  const restaurants = add(book, {
    parentId: f.food, name: "Restaurants", type: "expense", currency: "ILS", isPlaceholder: false,
  });
  book = restaurants.book;
  const car = add(book, {
    parentId: f.expenses, name: "Car", type: "expense", currency: "ILS", isPlaceholder: true,
  });
  book = car.book;
  const fuel = add(book, {
    parentId: car.id, name: "Fuel", type: "expense", currency: "ILS", isPlaceholder: false,
  });
  book = fuel.book;
  const repairs = add(book, {
    parentId: car.id, name: "Repairs", type: "expense", currency: "ILS", isPlaceholder: false,
  });
  book = repairs.book;
  return { ...f, book, restaurants: restaurants.id, car: car.id, fuel: fuel.id, repairs: repairs.id };
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
      budgeted: 9520,
      unbudgeted: 0,
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
      budgeted: 14000,
      unbudgeted: 0,
      limit: 10000,
      pct: 100,
      over: true,
    });
  });

  it("floors the bar at zero when refunds outweigh spending", () => {
    const f = fixture();
    // Refund: credit the expense account, debit cash — the mirror of `spend`.
    let book = unwrap(
      postEntry(f.book, {
        date: "2026-08-12",
        description: "returned the blender",
        postings: [
          { accountId: f.cash, side: "debit", amount: 200 },
          { accountId: f.groceries, side: "credit", amount: 200 },
        ],
      }),
    );
    book = unwrap(
      setBudget(book, { accountId: f.food, currency: "ILS", period: "month", limit: 1000 }),
    );
    expect(hero(book)).toEqual({
      kind: "budgeted",
      spent: -200,
      budgeted: -200,
      unbudgeted: 0,
      limit: 1000,
      pct: 0,
      over: false,
    });
  });

  it("shows a zero-limit month with no spending as 100%, not NaN", () => {
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
          spent: 0,
          remaining: 0,
        },
      ],
      unbudgeted: {},
    };
    const result = heroState(book, { ILS: { income: 0, expense: 0 } }, report);
    expect(result).toEqual({
      kind: "budgeted",
      spent: 0,
      budgeted: 0,
      unbudgeted: 0,
      limit: 0,
      pct: 100,
      over: false,
    });
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
    expect(result).toEqual({
      kind: "budgeted",
      spent: 3000,
      budgeted: 3000,
      unbudgeted: 0,
      limit: 10000,
      pct: 30,
      over: false,
    });
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

  it("keeps the bar within limits when some spend falls outside every budget", () => {
    const f = fixture();
    // 700 inside Food's limit, 8000 on Rent, which no limit covers at all.
    let book = spend(f.book, f.cash, f.groceries, 700);
    book = spend(book, f.cash, f.rent, 8000);
    book = unwrap(
      setBudget(book, { accountId: f.food, currency: "ILS", period: "month", limit: 1000 }),
    );
    expect(hero(book)).toEqual({
      kind: "budgeted",
      spent: 8700,
      budgeted: 700,
      unbudgeted: 8000,
      limit: 1000,
      pct: 70,
      over: false,
    });
  });

  it("separates budgeted spend from unbudgeted spend under nested limits", () => {
    const f = fixtureWide();
    let book = f.book;
    book = spend(book, f.cash, f.groceries, 700);
    book = spend(book, f.cash, f.restaurants, 200);
    book = spend(book, f.cash, f.fuel, 1300);
    book = spend(book, f.cash, f.repairs, 400);
    book = spend(book, f.cash, f.rent, 8000);
    book = unwrap(
      setBudget(book, { accountId: f.food, currency: "ILS", period: "month", limit: 1000 }),
    );
    book = unwrap(
      setBudget(book, { accountId: f.groceries, currency: "ILS", period: "month", limit: 600 }),
    );
    book = unwrap(
      setBudget(book, { accountId: f.car, currency: "ILS", period: "month", limit: 2000 }),
    );
    book = unwrap(
      setBudget(book, { accountId: f.fuel, currency: "ILS", period: "month", limit: 1200 }),
    );
    // spent: 700 + 200 + 1300 + 400 + 8000 = 10600 (all expense leaves).
    // unbudgeted: only Rent — every other leaf sits under a budgeted Food/Car group.
    // budgeted: 10600 - 8000 = 2600.
    // limit: Food (1000) + Car (2000); Groceries and Fuel are nested and dropped.
    expect(hero(book)).toEqual({
      kind: "budgeted",
      spent: 10600,
      budgeted: 2600,
      unbudgeted: 8000,
      limit: 3000,
      pct: 87,
      over: false,
    });
  });
});
