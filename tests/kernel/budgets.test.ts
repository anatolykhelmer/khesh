import { createAccount, deleteAccount } from "../../src/kernel/accounts";
import { removeBudget, setBudget } from "../../src/kernel/budgets";
import { createBook } from "../../src/kernel/create-book";
import type { AccountType, Book } from "../../src/kernel/types";
import { unwrap, unwrapErr } from "../helpers";

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

function fixture() {
  let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
  const expenses = add(book, {
    parentId: null,
    name: "Expenses",
    type: "expense",
    currency: "ILS",
    isPlaceholder: true,
  });
  book = expenses.book;
  const food = add(book, {
    parentId: expenses.id,
    name: "Food",
    type: "expense",
    currency: "ILS",
    isPlaceholder: false,
  });
  book = food.book;
  const cash = add(book, {
    parentId: null,
    name: "Cash",
    type: "asset",
    currency: "ILS",
    isPlaceholder: false,
  });
  book = cash.book;
  return { book, expenses: expenses.id, food: food.id, cash: cash.id };
}

describe("setBudget", () => {
  it("adds a limit on a leaf", () => {
    const { book, food } = fixture();
    const next = unwrap(
      setBudget(book, { accountId: food, period: "month", currency: "ILS", limit: 400000 }),
    );
    expect(next.budgets).toEqual([
      { accountId: food, period: "month", currency: "ILS", limit: 400000 },
    ]);
    expect(book.budgets).toEqual([]);
  });

  it("adds a limit on a group", () => {
    const { book, expenses } = fixture();
    const next = unwrap(
      setBudget(book, { accountId: expenses, period: "year", currency: "ILS", limit: 900000 }),
    );
    expect(next.budgets).toHaveLength(1);
    expect(next.budgets[0].accountId).toBe(expenses);
  });

  it("overwrites the amount for an existing key instead of adding a second row", () => {
    const { book, food } = fixture();
    const once = unwrap(
      setBudget(book, { accountId: food, period: "month", currency: "ILS", limit: 400000 }),
    );
    const twice = unwrap(
      setBudget(once, { accountId: food, period: "month", currency: "ILS", limit: 500000 }),
    );
    expect(twice.budgets).toEqual([
      { accountId: food, period: "month", currency: "ILS", limit: 500000 },
    ]);
  });

  it("keeps limits that differ in period or currency apart", () => {
    const { book, food } = fixture();
    let next = unwrap(
      setBudget(book, { accountId: food, period: "month", currency: "ILS", limit: 400000 }),
    );
    next = unwrap(
      setBudget(next, { accountId: food, period: "year", currency: "ILS", limit: 4000000 }),
    );
    next = unwrap(
      setBudget(next, { accountId: food, period: "month", currency: "USD", limit: 30000 }),
    );
    expect(next.budgets).toHaveLength(3);
  });

  it("rejects an unknown account", () => {
    const { book } = fixture();
    expect(
      unwrapErr(
        setBudget(book, { accountId: "nope", period: "month", currency: "ILS", limit: 1 }),
      ).code,
    ).toBe("ACCOUNT_NOT_FOUND");
  });

  it("rejects an account that is not an expense account", () => {
    const { book, cash } = fixture();
    expect(
      unwrapErr(
        setBudget(book, { accountId: cash, period: "month", currency: "ILS", limit: 1 }),
      ).code,
    ).toBe("ACCOUNT_TYPE_MISMATCH");
  });

  it("rejects an invalid currency code", () => {
    const { book, food } = fixture();
    expect(
      unwrapErr(
        setBudget(book, { accountId: food, period: "month", currency: "ils", limit: 1 }),
      ).code,
    ).toBe("INVALID_CURRENCY_CODE");
  });

  it("rejects a limit that is not a positive integer", () => {
    const { book, food } = fixture();
    for (const limit of [0, -100, 12.5]) {
      expect(
        unwrapErr(
          setBudget(book, { accountId: food, period: "month", currency: "ILS", limit }),
        ).code,
      ).toBe("BUDGET_LIMIT_INVALID");
    }
  });
});

describe("removeBudget", () => {
  it("removes the matching limit only", () => {
    const { book, food } = fixture();
    let next = unwrap(
      setBudget(book, { accountId: food, period: "month", currency: "ILS", limit: 400000 }),
    );
    next = unwrap(
      setBudget(next, { accountId: food, period: "year", currency: "ILS", limit: 4000000 }),
    );
    const removed = unwrap(
      removeBudget(next, { accountId: food, period: "month", currency: "ILS" }),
    );
    expect(removed.budgets).toEqual([
      { accountId: food, period: "year", currency: "ILS", limit: 4000000 },
    ]);
    expect(next.budgets).toHaveLength(2);
  });

  it("reports a missing limit", () => {
    const { book, food } = fixture();
    expect(
      unwrapErr(removeBudget(book, { accountId: food, period: "month", currency: "ILS" })).code,
    ).toBe("BUDGET_NOT_FOUND");
  });
});

describe("deleteAccount and budgets", () => {
  it("drops the limits of the account it deletes", () => {
    const { book, food, expenses } = fixture();
    let next = unwrap(
      setBudget(book, { accountId: food, period: "month", currency: "ILS", limit: 400000 }),
    );
    next = unwrap(
      setBudget(next, { accountId: expenses, period: "month", currency: "ILS", limit: 900000 }),
    );
    const deleted = unwrap(deleteAccount(next, food));
    expect(deleted.budgets).toEqual([
      { accountId: expenses, period: "month", currency: "ILS", limit: 900000 },
    ]);
  });
});
