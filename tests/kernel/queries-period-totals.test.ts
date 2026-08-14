import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { periodTotals } from "../../src/kernel/queries";
import { unwrap, unwrapErr } from "../helpers";

describe("periodTotals", () => {
  function bookWithAccounts() {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }),
    );
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Salary",
        type: "income",
        currency: "ILS",
        isPlaceholder: false,
      }),
    );
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Food",
        type: "expense",
        currency: "ILS",
        isPlaceholder: false,
      }),
    );
    return {
      book,
      cash: book.accounts[0].id,
      salary: book.accounts[1].id,
      food: book.accounts[2].id,
    };
  }

  it("sums income and expense within an inclusive date range", () => {
    let { book, cash, salary, food } = bookWithAccounts();
    book = unwrap(
      postEntry(book, {
        date: "2026-08-01",
        description: "Paycheck",
        postings: [
          { accountId: cash, side: "debit", amount: 500000 },
          { accountId: salary, side: "credit", amount: 500000 },
        ],
      }),
    );
    book = unwrap(
      postEntry(book, {
        date: "2026-08-31",
        description: "Groceries",
        postings: [
          { accountId: food, side: "debit", amount: 3000 },
          { accountId: cash, side: "credit", amount: 3000 },
        ],
      }),
    );
    const totals = unwrap(periodTotals(book, { from: "2026-08-01", to: "2026-08-31" }));
    expect(totals).toEqual({ ILS: { income: 500000, expense: 3000 } });
  });

  it("excludes entries outside the range", () => {
    let { book, cash, food } = bookWithAccounts();
    book = unwrap(
      postEntry(book, {
        date: "2026-07-31",
        description: "Before range",
        postings: [
          { accountId: food, side: "debit", amount: 1000 },
          { accountId: cash, side: "credit", amount: 1000 },
        ],
      }),
    );
    book = unwrap(
      postEntry(book, {
        date: "2026-09-01",
        description: "After range",
        postings: [
          { accountId: food, side: "debit", amount: 2000 },
          { accountId: cash, side: "credit", amount: 2000 },
        ],
      }),
    );
    const totals = unwrap(periodTotals(book, { from: "2026-08-01", to: "2026-08-31" }));
    expect(totals).toEqual({ ILS: { income: 0, expense: 0 } });
  });

  it("reports foreign-currency accounts under their own currency key", () => {
    let { book, food } = bookWithAccounts();
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "USD Cash",
        type: "asset",
        currency: "USD",
        isPlaceholder: false,
      }),
    );
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "USD Rent",
        type: "expense",
        currency: "USD",
        isPlaceholder: false,
      }),
    );
    const usdCash = book.accounts[book.accounts.length - 2].id;
    const usdRent = book.accounts[book.accounts.length - 1].id;
    book = unwrap(
      postEntry(book, {
        date: "2026-08-05",
        description: "USD rent",
        postings: [
          { accountId: usdRent, side: "debit", amount: 400000 },
          { accountId: usdCash, side: "credit", amount: 400000 },
        ],
      }),
    );
    book = unwrap(
      postEntry(book, {
        date: "2026-08-06",
        description: "ILS groceries",
        postings: [
          { accountId: food, side: "debit", amount: 3000 },
          { accountId: book.accounts[0].id, side: "credit", amount: 3000 },
        ],
      }),
    );
    const totals = unwrap(periodTotals(book, { from: "2026-08-01", to: "2026-08-31" }));
    expect(totals).toEqual({
      ILS: { income: 0, expense: 3000 },
      USD: { income: 0, expense: 400000 },
    });
  });

  it("returns zero totals when nothing matches", () => {
    const { book } = bookWithAccounts();
    const totals = unwrap(periodTotals(book, { from: "2026-08-01", to: "2026-08-31" }));
    expect(totals).toEqual({ ILS: { income: 0, expense: 0 } });
  });

  it("rejects an invalid from date", () => {
    const { book } = bookWithAccounts();
    expect(unwrapErr(periodTotals(book, { from: "nope", to: "2026-08-31" })).code).toBe(
      "ENTRY_DATE_INVALID",
    );
  });

  it("rejects an invalid to date", () => {
    const { book } = bookWithAccounts();
    expect(unwrapErr(periodTotals(book, { from: "2026-08-01", to: "nope" })).code).toBe(
      "ENTRY_DATE_INVALID",
    );
  });
});
