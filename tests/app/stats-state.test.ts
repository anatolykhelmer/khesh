import { describe, expect, it } from "vitest";
import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import {
  expenseRootId,
  parseStatsState,
  statsView,
  toStatsParams,
} from "../../src/app/stats-state";
import type { PeriodSlice } from "../../src/kernel/queries";
import { NOW as ISO_NOW, unwrap } from "../helpers";

const NOW = new Date(2026, 7, 12); // 12 August 2026

function bookWithRoots() {
  let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, ISO_NOW));
  book = unwrap(
    createAccount(book, {
      parentId: null,
      name: "Assets",
      type: "asset",
      currency: "ILS",
      isPlaceholder: true,
    }, ISO_NOW),
  );
  book = unwrap(
    createAccount(book, {
      parentId: null,
      name: "Expenses",
      type: "expense",
      currency: "ILS",
      isPlaceholder: true,
    }, ISO_NOW),
  );
  const expenses = book.accounts[1].id;
  book = unwrap(
    createAccount(book, {
      parentId: expenses,
      name: "Food",
      type: "expense",
      currency: "ILS",
      isPlaceholder: false,
    }, ISO_NOW),
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
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, ISO_NOW));
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Other",
        type: "expense",
        currency: "ILS",
        isPlaceholder: true,
      }, ISO_NOW),
    );
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Expenses",
        type: "expense",
        currency: "ILS",
        isPlaceholder: true,
      }, ISO_NOW),
    );
    expect(expenseRootId(book)).toBe(book.accounts[1].id);
  });

  it("returns null when there is no expense root", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, ISO_NOW));
    expect(expenseRootId(book)).toBeNull();
  });

  it("picks the first name when several roots exist and none is Expenses", () => {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, ISO_NOW));
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Zoo",
        type: "expense",
        currency: "ILS",
        isPlaceholder: true,
      }, ISO_NOW),
    );
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Alpha",
        type: "expense",
        currency: "ILS",
        isPlaceholder: true,
      }, ISO_NOW),
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

function slice(id: string, amount: number): PeriodSlice {
  return { id, name: id, isGroup: false, amount };
}

describe("statsView", () => {
  it("draws the pie from the positives and still lists a refunded child", () => {
    const children = [slice("food", 20000), slice("travel", 10000), slice("refund", -6400)];
    const view = statsView({ isGroup: true, total: 23600, children });

    expect(view.positive.map((s) => s.id)).toEqual(["food", "travel"]);
    expect(view.showPie).toBe(true);
    expect(view.showLegend).toBe(true);
    expect(view.showTotal).toBe(true);
  });

  it("a leaf with a net refund prints its total with no pie, legend or empty message", () => {
    const view = statsView({ isGroup: false, total: -6400, children: [] });

    expect(view.showPie).toBe(false);
    expect(view.showLegend).toBe(false);
    expect(view.showTotal).toBe(true);
  });

  it("a group netting to zero prints the total over its legend with no pie", () => {
    const children = [slice("food", 6400), slice("refund", -6400)];
    const view = statsView({ isGroup: true, total: 0, children });

    expect(view.showPie).toBe(false);
    expect(view.showLegend).toBe(true);
    expect(view.showTotal).toBe(true);
  });

  it("an empty month shows the empty message instead of a total", () => {
    const view = statsView({ isGroup: true, total: 0, children: [] });

    expect(view.showPie).toBe(false);
    expect(view.showLegend).toBe(false);
    expect(view.showTotal).toBe(false);
  });

  it("the happy path keeps the six colour classes and wraps after them", () => {
    const children = Array.from({ length: 7 }, (_, i) => slice(`c${i}`, 1000 * (i + 1)));
    const view = statsView({ isGroup: true, total: 28000, children });

    expect(view.showPie).toBe(true);
    expect(children.map((child) => view.swatchClass(child.id))).toEqual([
      "swatch cat-0",
      "swatch cat-1",
      "swatch cat-2",
      "swatch cat-3",
      "swatch cat-4",
      "swatch cat-5",
      "swatch cat-0",
    ]);
  });

  it("the swatch class of a negative child is a bare swatch", () => {
    const children = [slice("food", 20000), slice("refund", -6400)];
    const view = statsView({ isGroup: true, total: 13600, children });

    expect(view.swatchClass("refund")).toBe("swatch");
    expect(view.swatchClass("gone")).toBe("swatch");
  });

  it("swatch indices follow the positive slices, not the full children list", () => {
    const children = [slice("refund", -6400), slice("food", 20000), slice("travel", 10000)];
    const view = statsView({ isGroup: true, total: 23600, children });

    expect(view.swatchClass("food")).toBe("swatch cat-0");
    expect(view.swatchClass("travel")).toBe("swatch cat-1");
  });
});
