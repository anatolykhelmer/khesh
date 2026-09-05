import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { validateBook } from "../../src/kernel/validate";
import type { Book } from "../../src/kernel/types";
import { NOW, unwrap, unwrapErr } from "../helpers";

describe("validateBook", () => {
  it("accepts a valid book", () => {
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
        name: "Food",
        type: "expense",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    book = unwrap(
      postEntry(book, {
        date: "2026-01-01",
        description: "X",
        postings: [
          { accountId: book.accounts[1].id, side: "debit", amount: 1 },
          { accountId: book.accounts[0].id, side: "credit", amount: 1 },
        ],
      }, NOW),
    );
    expect(unwrap(validateBook(book))).toBe(true);
  });

  it("reports ACCOUNT_ID_DUPLICATE for duplicate account ids", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    book.accounts.push(
      {
        id: "dup",
        parentId: null,
        name: "One",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
        updatedAt: NOW,
      },
      {
        id: "dup",
        parentId: null,
        name: "Two",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
        updatedAt: NOW,
      },
    );
    const error = unwrapErr(validateBook(book));
    const codes = (error.details?.violations as { code: string }[]).map((v) => v.code);
    expect(codes).toContain("ACCOUNT_ID_DUPLICATE");
  });

  it("reports ENTRY_ID_DUPLICATE for duplicate journal ids", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    book.journal.push(
      {
        id: "dup",
        date: "2026-01-01",
        description: "A",
        kind: "standard",
        postings: [],
        updatedAt: NOW,
      },
      {
        id: "dup",
        date: "2026-01-02",
        description: "B",
        kind: "standard",
        postings: [],
        updatedAt: NOW,
      },
    );
    const error = unwrapErr(validateBook(book));
    const codes = (error.details?.violations as { code: string }[]).map((v) => v.code);
    expect(codes).toContain("ENTRY_ID_DUPLICATE");
  });

  it("collects multiple violations", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    book.accounts.push(
      {
        id: "a1",
        parentId: "missing",
        name: "",
        type: "asset",
        currency: "ils",
        isPlaceholder: false,
        updatedAt: NOW,
      },
      {
        id: "a1",
        parentId: null,
        name: "Dup",
        type: "expense",
        currency: "ILS",
        isPlaceholder: false,
        updatedAt: NOW,
      },
    );
    const error = unwrapErr(validateBook(book));
    expect(error.code).toBe("BOOK_INVALID");
    const codes = (error.details?.violations as { code: string }[]).map((v) => v.code);
    expect(codes.length).toBeGreaterThan(1);
  });
});

describe("validateBook budgets", () => {
  function fixture() {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));

    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Expenses",
        type: "expense",
        currency: "ILS",
        isPlaceholder: true,
      }, NOW),
    );
    const expensesId = book.accounts[book.accounts.length - 1].id;

    book = unwrap(
      createAccount(book, {
        parentId: expensesId,
        name: "Food",
        type: "expense",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    const foodId = book.accounts[book.accounts.length - 1].id;

    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    const cashId = book.accounts[book.accounts.length - 1].id;

    return { book, food: foodId, cash: cashId };
  }

  function withBudgets(book: Book, budgets: unknown[]): Book {
    return { ...book, budgets: budgets as Book["budgets"] };
  }

  it("rejects a limit on an unknown account", () => {
    const { book } = fixture();
    const violated = unwrapErr(
      validateBook(
        withBudgets(book, [
          { accountId: "nope", period: "month", currency: "ILS", limit: 100 },
        ]),
      ),
    );
    expect(violated.code).toBe("BOOK_INVALID");
    expect(JSON.stringify(violated.details)).toContain("ACCOUNT_NOT_FOUND");
  });

  it("rejects a limit on a non-expense account", () => {
    const { book, cash } = fixture();
    const violated = unwrapErr(
      validateBook(
        withBudgets(book, [
          { accountId: cash, period: "month", currency: "ILS", limit: 100 },
        ]),
      ),
    );
    expect(JSON.stringify(violated.details)).toContain("ACCOUNT_TYPE_MISMATCH");
  });

  it("rejects a duplicate key", () => {
    const { book, food } = fixture();
    const violated = unwrapErr(
      validateBook(
        withBudgets(book, [
          { accountId: food, period: "month", currency: "ILS", limit: 100 },
          { accountId: food, period: "month", currency: "ILS", limit: 200 },
        ]),
      ),
    );
    expect(JSON.stringify(violated.details)).toContain("BUDGET_DUPLICATE");
  });

  it("rejects a non-positive limit", () => {
    const { book, food } = fixture();
    const violated = unwrapErr(
      validateBook(
        withBudgets(book, [
          { accountId: food, period: "month", currency: "ILS", limit: 0 },
        ]),
      ),
    );
    expect(JSON.stringify(violated.details)).toContain("BUDGET_LIMIT_INVALID");
  });
});
