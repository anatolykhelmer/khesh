import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { validateBook } from "../../src/kernel/validate";
import { unwrap, unwrapErr } from "../helpers";

describe("validateBook", () => {
  it("accepts a valid book", () => {
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
        name: "Food",
        type: "expense",
        currency: "ILS",
        isPlaceholder: false,
      }),
    );
    book = unwrap(
      postEntry(book, {
        date: "2026-01-01",
        description: "X",
        postings: [
          { accountId: book.accounts[1].id, side: "debit", amount: 1 },
          { accountId: book.accounts[0].id, side: "credit", amount: 1 },
        ],
      }),
    );
    expect(unwrap(validateBook(book))).toBe(true);
  });

  it("reports ACCOUNT_ID_DUPLICATE for duplicate account ids", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
    book.accounts.push(
      {
        id: "dup",
        parentId: null,
        name: "One",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      },
      {
        id: "dup",
        parentId: null,
        name: "Two",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      },
    );
    const error = unwrapErr(validateBook(book));
    const codes = (error.details?.violations as { code: string }[]).map((v) => v.code);
    expect(codes).toContain("ACCOUNT_ID_DUPLICATE");
  });

  it("reports ENTRY_ID_DUPLICATE for duplicate journal ids", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
    book.journal.push(
      {
        id: "dup",
        date: "2026-01-01",
        description: "A",
        kind: "standard",
        postings: [],
      },
      {
        id: "dup",
        date: "2026-01-02",
        description: "B",
        kind: "standard",
        postings: [],
      },
    );
    const error = unwrapErr(validateBook(book));
    const codes = (error.details?.violations as { code: string }[]).map((v) => v.code);
    expect(codes).toContain("ENTRY_ID_DUPLICATE");
  });

  it("collects multiple violations", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
    book.accounts.push(
      {
        id: "a1",
        parentId: "missing",
        name: "",
        type: "asset",
        currency: "ils",
        isPlaceholder: false,
      },
      {
        id: "a1",
        parentId: null,
        name: "Dup",
        type: "expense",
        currency: "ILS",
        isPlaceholder: false,
      },
    );
    const error = unwrapErr(validateBook(book));
    expect(error.code).toBe("BOOK_INVALID");
    const codes = (error.details?.violations as { code: string }[]).map((v) => v.code);
    expect(codes.length).toBeGreaterThan(1);
  });
});
