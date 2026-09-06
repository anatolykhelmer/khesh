import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { periodBreakdown, periodTotals } from "../../src/kernel/queries";
import { NOW, unwrap, unwrapErr } from "../helpers";

const RANGE = { from: "2026-08-01", to: "2026-08-31" };

function tree() {
  let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
  book = unwrap(
    createAccount(book, {
      parentId: null,
      name: "Cash",
      type: "asset",
      currency: "ILS",
      isPlaceholder: false,
    }, NOW),
  );
  book = unwrap(
    createAccount(book, {
      parentId: null,
      name: "USD Cash",
      type: "asset",
      currency: "USD",
      isPlaceholder: false,
    }, NOW),
  );
  book = unwrap(
    createAccount(book, {
      parentId: null,
      name: "Salary",
      type: "income",
      currency: "ILS",
      isPlaceholder: false,
    }, NOW),
  );
  book = unwrap(
    createAccount(book, {
      parentId: null,
      name: "Expenses",
      type: "expense",
      currency: "ILS",
      isPlaceholder: true,
    }, NOW),
  );
  const cash = book.accounts[0].id;
  const usdCash = book.accounts[1].id;
  const salary = book.accounts[2].id;
  const expenses = book.accounts[3].id;
  book = unwrap(
    createAccount(book, {
      parentId: expenses,
      name: "Food",
      type: "expense",
      currency: "ILS",
      isPlaceholder: true,
    }, NOW),
  );
  const food = book.accounts[4].id;
  book = unwrap(
    createAccount(book, {
      parentId: food,
      name: "Groceries",
      type: "expense",
      currency: "ILS",
      isPlaceholder: false,
    }, NOW),
  );
  book = unwrap(
    createAccount(book, {
      parentId: food,
      name: "Cafes",
      type: "expense",
      currency: "ILS",
      isPlaceholder: false,
    }, NOW),
  );
  book = unwrap(
    createAccount(book, {
      parentId: expenses,
      name: "Rent",
      type: "expense",
      currency: "ILS",
      isPlaceholder: false,
    }, NOW),
  );
  book = unwrap(
    createAccount(book, {
      parentId: expenses,
      name: "Travel",
      type: "expense",
      currency: "USD",
      isPlaceholder: false,
    }, NOW),
  );
  return {
    book,
    cash,
    usdCash,
    salary,
    expenses,
    food,
    groceries: book.accounts[5].id,
    cafes: book.accounts[6].id,
    rent: book.accounts[7].id,
    travel: book.accounts[8].id,
  };
}

function spend(
  book: ReturnType<typeof tree>["book"],
  date: string,
  expenseId: string,
  assetId: string,
  amount: number,
) {
  return unwrap(
    postEntry(book, {
      date,
      description: "spend",
      postings: [
        { accountId: expenseId, side: "debit", amount },
        { accountId: assetId, side: "credit", amount },
      ],
    }, NOW),
  );
}

describe("periodBreakdown", () => {
  it("rejects an invalid from date", () => {
    const { book, expenses } = tree();
    expect(unwrapErr(periodBreakdown(book, { from: "nope", to: "2026-08-31" }, expenses)).code).toBe(
      "ENTRY_DATE_INVALID",
    );
  });

  it("rejects an invalid to date", () => {
    const { book, expenses } = tree();
    expect(unwrapErr(periodBreakdown(book, { from: "2026-08-01", to: "nope" }, expenses)).code).toBe(
      "ENTRY_DATE_INVALID",
    );
  });

  it("rejects an unknown account", () => {
    const { book } = tree();
    expect(unwrapErr(periodBreakdown(book, RANGE, "gone")).code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("rejects a non-expense account", () => {
    const { book, salary } = tree();
    expect(unwrapErr(periodBreakdown(book, RANGE, salary)).code).toBe("ACCOUNT_TYPE_MISMATCH");
  });

  it("rolls a grandchild into its parent and omits zero children", () => {
    let t = tree();
    t.book = spend(t.book, "2026-08-10", t.groceries, t.cash, 3000);
    t.book = spend(t.book, "2026-08-11", t.rent, t.cash, 10000);
    const result = unwrap(periodBreakdown(t.book, RANGE, t.expenses));
    expect(result).toMatchObject({
      accountId: t.expenses,
      name: "Expenses",
      isGroup: true,
      currency: "ILS",
      total: 13000,
      currencies: ["ILS"],
      ancestors: [],
    });
    expect(result.children).toEqual([
      { id: t.rent, name: "Rent", isGroup: false, amount: 10000 },
      { id: t.food, name: "Food", isGroup: true, amount: 3000 },
    ]);
  });

  it("returns a leaf with no children", () => {
    let t = tree();
    t.book = spend(t.book, "2026-08-10", t.groceries, t.cash, 3000);
    const result = unwrap(periodBreakdown(t.book, RANGE, t.groceries));
    expect(result).toMatchObject({
      accountId: t.groceries,
      name: "Groceries",
      isGroup: false,
      currency: "ILS",
      total: 3000,
      children: [],
      currencies: ["ILS"],
      ancestors: [
        { id: t.expenses, name: "Expenses" },
        { id: t.food, name: "Food" },
      ],
    });
  });

  it("ignores entries outside an inclusive range", () => {
    let t = tree();
    t.book = spend(t.book, "2026-07-31", t.rent, t.cash, 1000);
    t.book = spend(t.book, "2026-08-01", t.rent, t.cash, 2000);
    t.book = spend(t.book, "2026-08-31", t.rent, t.cash, 3000);
    t.book = spend(t.book, "2026-09-01", t.rent, t.cash, 4000);
    expect(unwrap(periodBreakdown(t.book, RANGE, t.rent)).total).toBe(5000);
  });

  it("lists currencies with activity, home first, and defaults to the first when home is idle", () => {
    let t = tree();
    t.book = spend(t.book, "2026-08-10", t.travel, t.usdCash, 400000);
    const result = unwrap(periodBreakdown(t.book, RANGE, t.expenses));
    expect(result.currencies).toEqual(["USD"]);
    expect(result.currency).toBe("USD");
    expect(result.total).toBe(400000);
    expect(result.children).toEqual([
      { id: t.travel, name: "Travel", isGroup: false, amount: 400000 },
    ]);
  });

  it("keeps ILS and USD as separate pies", () => {
    let t = tree();
    t.book = spend(t.book, "2026-08-10", t.rent, t.cash, 10000);
    t.book = spend(t.book, "2026-08-10", t.travel, t.usdCash, 400000);
    const ils = unwrap(periodBreakdown(t.book, RANGE, t.expenses, "ILS"));
    expect(ils.currency).toBe("ILS");
    expect(ils.total).toBe(10000);
    expect(ils.currencies).toEqual(["ILS", "USD"]);
    expect(ils.children.map((c) => c.id)).toEqual([t.rent]);
    const usd = unwrap(periodBreakdown(t.book, RANGE, t.expenses, "USD"));
    expect(usd.currency).toBe("USD");
    expect(usd.total).toBe(400000);
    expect(usd.children.map((c) => c.id)).toEqual([t.travel]);
  });

  it("omits a child whose signed amount is not positive", () => {
    let t = tree();
    t.book = spend(t.book, "2026-08-10", t.rent, t.cash, 10000);
    t.book = unwrap(
      postEntry(t.book, {
        date: "2026-08-12",
        description: "refund",
        postings: [
          { accountId: t.cash, side: "debit", amount: 500 },
          { accountId: t.groceries, side: "credit", amount: 500 },
        ],
      }, NOW),
    );
    const result = unwrap(periodBreakdown(t.book, RANGE, t.expenses));
    expect(result.total).toBe(9500);
    expect(result.children.map((c) => c.id)).toEqual([t.rent]);
  });

  it("leaves periodTotals behaviour unchanged", () => {
    let t = tree();
    t.book = spend(t.book, "2026-08-10", t.rent, t.cash, 10000);
    expect(unwrap(periodTotals(t.book, RANGE))).toEqual({
      ILS: { income: 0, expense: 10000 },
      USD: { income: 0, expense: 0 },
    });
  });
});
