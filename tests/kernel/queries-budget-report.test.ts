import { createAccount } from "../../src/kernel/accounts";
import { setBudget } from "../../src/kernel/budgets";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { budgetReport } from "../../src/kernel/queries";
import type { AccountType, Book } from "../../src/kernel/types";
import { unwrap, unwrapErr } from "../helpers";

const MONTH = { from: "2026-08-01", to: "2026-08-31" };
const YEAR = { from: "2026-01-01", to: "2026-12-31" };

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

/** Expenses > Food > {Groceries ILS, Restaurants ILS, Trips USD}, plus Expenses > Rent ILS. */
function fixture() {
  let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
  const cash = add(book, {
    parentId: null, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false,
  });
  book = cash.book;
  const usdCash = add(book, {
    parentId: null, name: "USD Cash", type: "asset", currency: "USD", isPlaceholder: false,
  });
  book = usdCash.book;
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
  const restaurants = add(book, {
    parentId: food.id, name: "Restaurants", type: "expense", currency: "ILS", isPlaceholder: false,
  });
  book = restaurants.book;
  const trips = add(book, {
    parentId: food.id, name: "Trips", type: "expense", currency: "USD", isPlaceholder: false,
  });
  book = trips.book;
  const rent = add(book, {
    parentId: expenses.id, name: "Rent", type: "expense", currency: "ILS", isPlaceholder: false,
  });
  book = rent.book;
  return {
    book,
    cash: cash.id,
    usdCash: usdCash.id,
    expenses: expenses.id,
    food: food.id,
    groceries: groceries.id,
    restaurants: restaurants.id,
    trips: trips.id,
    rent: rent.id,
  };
}

function spend(
  book: Book,
  leaf: string,
  source: string,
  amount: number,
  date = "2026-08-10",
): Book {
  return unwrap(
    postEntry(book, {
      date,
      description: "x",
      postings: [
        { accountId: leaf, side: "debit", amount },
        { accountId: source, side: "credit", amount },
      ],
    }),
  );
}

function refund(
  book: Book,
  leaf: string,
  source: string,
  amount: number,
  date = "2026-08-12",
): Book {
  return unwrap(
    postEntry(book, {
      date,
      description: "refund",
      postings: [
        { accountId: source, side: "debit", amount },
        { accountId: leaf, side: "credit", amount },
      ],
    }),
  );
}

describe("budgetReport", () => {
  it("rejects an invalid range", () => {
    const { book } = fixture();
    expect(unwrapErr(budgetReport(book, "month", { from: "nope", to: "2026-08-31" })).code).toBe(
      "ENTRY_DATE_INVALID",
    );
    expect(unwrapErr(budgetReport(book, "month", { from: "2026-08-01", to: "nope" })).code).toBe(
      "ENTRY_DATE_INVALID",
    );
  });

  it("reports spending against a leaf limit", () => {
    const f = fixture();
    let book = spend(f.book, f.groceries, f.cash, 30000);
    book = unwrap(
      setBudget(book, {
        accountId: f.groceries, period: "month", currency: "ILS", limit: 50000,
      }),
    );
    const report = unwrap(budgetReport(book, "month", MONTH));
    expect(report.rows).toEqual([
      {
        accountId: f.groceries,
        name: "Groceries",
        path: "Expenses:Food:Groceries",
        isGroup: false,
        currency: "ILS",
        limit: 50000,
        spent: 30000,
        remaining: 20000,
      },
    ]);
  });

  it("sums the whole subtree for a group limit, in the limit's currency only", () => {
    const f = fixture();
    let book = spend(f.book, f.groceries, f.cash, 30000);
    book = spend(book, f.restaurants, f.cash, 12000);
    book = spend(book, f.trips, f.usdCash, 8000);
    book = unwrap(
      setBudget(book, { accountId: f.food, period: "month", currency: "ILS", limit: 50000 }),
    );
    const report = unwrap(budgetReport(book, "month", MONTH));
    expect(report.rows[0]).toMatchObject({ spent: 42000, remaining: 8000, isGroup: true });
  });

  it("counts foreign-currency spending only under a limit in that currency", () => {
    const f = fixture();
    let book = spend(f.book, f.trips, f.usdCash, 8000);
    book = unwrap(
      setBudget(book, { accountId: f.food, period: "month", currency: "USD", limit: 10000 }),
    );
    const report = unwrap(budgetReport(book, "month", MONTH));
    expect(report.rows[0]).toMatchObject({ currency: "USD", spent: 8000, remaining: 2000 });
  });

  it("lets a refund reduce what was spent", () => {
    const f = fixture();
    let book = spend(f.book, f.groceries, f.cash, 30000);
    book = refund(book, f.groceries, f.cash, 5000);
    book = unwrap(
      setBudget(book, {
        accountId: f.groceries, period: "month", currency: "ILS", limit: 50000,
      }),
    );
    expect(unwrap(budgetReport(book, "month", MONTH)).rows[0].spent).toBe(25000);
  });

  it("counts nested limits independently", () => {
    const f = fixture();
    let book = spend(f.book, f.restaurants, f.cash, 12000);
    book = unwrap(
      setBudget(book, { accountId: f.food, period: "month", currency: "ILS", limit: 50000 }),
    );
    book = unwrap(
      setBudget(book, {
        accountId: f.restaurants, period: "month", currency: "ILS", limit: 8000,
      }),
    );
    const report = unwrap(budgetReport(book, "month", MONTH));
    const byName = Object.fromEntries(report.rows.map((row) => [row.name, row]));
    expect(byName.Food.spent).toBe(12000);
    expect(byName.Restaurants.spent).toBe(12000);
    expect(byName.Restaurants.remaining).toBe(-4000);
  });

  it("orders rows by share of the limit used, then by path", () => {
    const f = fixture();
    let book = spend(f.book, f.groceries, f.cash, 10000);
    book = spend(book, f.rent, f.cash, 45000);
    book = unwrap(
      setBudget(book, {
        accountId: f.groceries, period: "month", currency: "ILS", limit: 50000,
      }),
    );
    book = unwrap(
      setBudget(book, { accountId: f.rent, period: "month", currency: "ILS", limit: 50000 }),
    );
    expect(unwrap(budgetReport(book, "month", MONTH)).rows.map((row) => row.name)).toEqual([
      "Rent",
      "Groceries",
    ]);
  });

  it("ignores limits of the other period", () => {
    const f = fixture();
    let book = spend(f.book, f.groceries, f.cash, 30000);
    book = unwrap(
      setBudget(book, {
        accountId: f.groceries, period: "year", currency: "ILS", limit: 500000,
      }),
    );
    expect(unwrap(budgetReport(book, "month", MONTH)).rows).toEqual([]);
    expect(unwrap(budgetReport(book, "year", YEAR)).rows).toHaveLength(1);
  });

  it("reports spending no limit covers, per currency", () => {
    const f = fixture();
    let book = spend(f.book, f.groceries, f.cash, 30000);
    book = spend(book, f.trips, f.usdCash, 8000);
    book = spend(book, f.rent, f.cash, 45000);
    book = unwrap(
      setBudget(book, { accountId: f.food, period: "month", currency: "ILS", limit: 50000 }),
    );
    const report = unwrap(budgetReport(book, "month", MONTH));
    // Groceries is covered through its Food ancestor; Trips is USD, Rent has no limit.
    expect(report.unbudgeted).toEqual({ ILS: 45000, USD: 8000 });
  });

  it("omits a currency whose uncovered spending nets to zero", () => {
    const f = fixture();
    let book = spend(f.book, f.rent, f.cash, 45000);
    book = refund(book, f.rent, f.cash, 45000);
    expect(unwrap(budgetReport(book, "month", MONTH)).unbudgeted).toEqual({});
  });

  it("includes both range boundaries", () => {
    const f = fixture();
    let book = spend(f.book, f.groceries, f.cash, 1000, "2026-08-01");
    book = spend(book, f.groceries, f.cash, 2000, "2026-08-31");
    book = spend(book, f.groceries, f.cash, 4000, "2026-09-01");
    book = unwrap(
      setBudget(book, {
        accountId: f.groceries, period: "month", currency: "ILS", limit: 50000,
      }),
    );
    expect(unwrap(budgetReport(book, "month", MONTH)).rows[0].spent).toBe(3000);
  });
});
