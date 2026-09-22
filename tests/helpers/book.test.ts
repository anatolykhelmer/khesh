import { describe, expect, it } from "vitest";
import { validateBook } from "../../src/kernel/validate";
import { accountNamed, realBook, ROOT } from "./book";

describe("realBook", () => {
  it("is a book validateBook accepts, with one placeholder root per category type", () => {
    const book = realBook();
    expect(validateBook(book).ok).toBe(true);
    expect(book.accounts.map((a) => [a.id, a.name, a.type, a.parentId, a.isPlaceholder])).toEqual([
      [ROOT.asset, "Assets", "asset", null, true],
      [ROOT.liability, "Liabilities", "liability", null, true],
      [ROOT.income, "Income", "income", null, true],
      [ROOT.expense, "Expenses", "expense", null, true],
    ]);
  });

  it("puts the roots in the book's home currency", () => {
    const book = realBook("USD");
    expect(book.homeCurrency).toBe("USD");
    expect(book.accounts.map((a) => a.currency)).toEqual(["USD", "USD", "USD", "USD"]);
  });

  it("takes other root ids, for a second device's separately onboarded book", () => {
    const ids = { asset: "b:asset", liability: "b:liability", income: "b:income", expense: "b:expense" };
    expect(realBook("ILS", "2026-09-02T10:00:00.000Z", ids).accounts.map((a) => a.id)).toEqual([
      "b:asset",
      "b:liability",
      "b:income",
      "b:expense",
    ]);
  });
});

describe("accountNamed", () => {
  it("finds the one account with that name", () => {
    expect(accountNamed(realBook(), "Income").id).toBe(ROOT.income);
  });

  it("throws, naming the account, when there is none or more than one", () => {
    const book = realBook();
    expect(() => accountNamed(book, "Cash")).toThrow(/"Cash".*found 0/);
    book.accounts.push({ ...book.accounts[0], id: "second" });
    expect(() => accountNamed(book, "Assets")).toThrow(/"Assets".*found 2/);
  });
});
