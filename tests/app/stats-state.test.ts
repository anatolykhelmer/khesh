import { describe, expect, it } from "vitest";
import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { expenseRootId, parseStatsState, toStatsParams } from "../../src/app/stats-state";
import { unwrap } from "../helpers";

const NOW = new Date(2026, 7, 12); // 12 August 2026

function bookWithRoots() {
  let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
  book = unwrap(
    createAccount(book, {
      parentId: null,
      name: "Assets",
      type: "asset",
      currency: "ILS",
      isPlaceholder: true,
    }),
  );
  book = unwrap(
    createAccount(book, {
      parentId: null,
      name: "Expenses",
      type: "expense",
      currency: "ILS",
      isPlaceholder: true,
    }),
  );
  const expenses = book.accounts[1].id;
  book = unwrap(
    createAccount(book, {
      parentId: expenses,
      name: "Food",
      type: "expense",
      currency: "ILS",
      isPlaceholder: false,
    }),
  );
  return { book, expenses, food: book.accounts[2].id };
}

describe("parseStatsState", () => {
  it("defaults to the current month, no account, no currency", () => {
    const { book } = bookWithRoots();
    expect(parseStatsState(new URLSearchParams(), book, NOW)).toEqual({
      period: { year: 2026, month: 8 },
      accountId: null,
      currency: null,
    });
  });

  it("reads month, account and currency", () => {
    const { book, food } = bookWithRoots();
    expect(
      parseStatsState(
        new URLSearchParams(`month=2026-03&account=${food}&currency=USD`),
        book,
        NOW,
      ),
    ).toEqual({
      period: { year: 2026, month: 3 },
      accountId: food,
      currency: "USD",
    });
  });

  it("falls back to the current month when the month is malformed", () => {
    const { book } = bookWithRoots();
    for (const raw of ["month=nonsense", "month=2026-13", "month=all", "month="]) {
      expect(parseStatsState(new URLSearchParams(raw), book, NOW).period).toEqual({
        year: 2026,
        month: 8,
      });
    }
  });

  it("drops an unknown or non-expense account id", () => {
    const { book } = bookWithRoots();
    const assets = book.accounts[0].id;
    expect(
      parseStatsState(new URLSearchParams("account=gone"), book, NOW).accountId,
    ).toBeNull();
    expect(
      parseStatsState(new URLSearchParams(`account=${assets}`), book, NOW).accountId,
    ).toBeNull();
  });
});

describe("expenseRootId", () => {
  it("returns the expense-type root", () => {
    const { book, expenses } = bookWithRoots();
    expect(expenseRootId(book)).toBe(expenses);
  });

  it("prefers the root named Expenses when several exist", () => {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Other",
        type: "expense",
        currency: "ILS",
        isPlaceholder: true,
      }),
    );
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Expenses",
        type: "expense",
        currency: "ILS",
        isPlaceholder: true,
      }),
    );
    expect(expenseRootId(book)).toBe(book.accounts[1].id);
  });

  it("returns null when there is no expense root", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
    expect(expenseRootId(book)).toBeNull();
  });

  it("picks the first name when several roots exist and none is Expenses", () => {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Zoo",
        type: "expense",
        currency: "ILS",
        isPlaceholder: true,
      }),
    );
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Alpha",
        type: "expense",
        currency: "ILS",
        isPlaceholder: true,
      }),
    );
    expect(expenseRootId(book)).toBe(book.accounts[1].id);
  });
});

describe("toStatsParams", () => {
  it("always writes month and omits null account and currency", () => {
    expect(
      toStatsParams({
        period: { year: 2026, month: 8 },
        accountId: null,
        currency: null,
      }).toString(),
    ).toBe("month=2026-08");
  });

  it("writes account and currency when set", () => {
    expect(
      toStatsParams({
        period: { year: 2026, month: 3 },
        accountId: "abc",
        currency: "USD",
      }).toString(),
    ).toBe("month=2026-03&account=abc&currency=USD");
  });
});
