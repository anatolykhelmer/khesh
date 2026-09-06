import { describe, expect, it } from "vitest";
import { createBook } from "../../src/kernel/create-book";
import { normalizeBook } from "../../src/kernel/normalize";
import { validateBook } from "../../src/kernel/validate";
import type { Book, Recurrence } from "../../src/kernel/types";
import { unwrap, unwrapErr, NOW } from "../helpers";

function emptyBook(): Book {
  return unwrap(createBook({ name: "Household", homeCurrency: "ILS" }, NOW));
}

function ruleOn(accountId: string, toAccountId: string): Recurrence {
  return {
    id: "r1",
    description: "Rent",
    fromAccountId: accountId,
    lines: [{ toAccountId, amount: 300000 }],
    every: 1,
    unit: "month",
    startDate: "2026-01-01",
    endDate: null,
    pausedAt: null,
    skipped: [],
    deferred: [],
    updatedAt: NOW,
  };
}

describe("schema v3", () => {
  it("creates books at version 3 with an empty recurrences array", () => {
    const book = emptyBook();
    expect(book.schemaVersion).toBe(3);
    expect(book.recurrences).toEqual([]);
  });

  it("migrates a v2 snapshot by adding the empty collection", () => {
    const v2 = {
      schemaVersion: 2 as const,
      name: "Household",
      homeCurrency: "ILS",
      metaUpdatedAt: NOW,
      accounts: [],
      journal: [],
      budgets: [],
      tombstones: [],
    };
    const migrated = normalizeBook(v2);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.recurrences).toEqual([]);
    expect(unwrap(validateBook(migrated))).toBe(true);
  });

  it("returns a snapshot from a newer schema untouched, and rejects it", () => {
    const future = { ...emptyBook(), schemaVersion: 4 } as unknown as Book;
    expect(normalizeBook(future).schemaVersion).toBe(4);
    expect(unwrapErr(validateBook(future)).code).toBe("BOOK_INVALID");
  });

  it("rejects a book whose recurrences field is not an array", () => {
    const broken = { ...emptyBook(), recurrences: null } as unknown as Book;
    expect(unwrapErr(validateBook(broken)).code).toBe("BOOK_INVALID");
  });

  it("rejects a rule whose accounts do not share one currency", () => {
    const book = emptyBook();
    book.accounts = [
      { id: "a", parentId: null, name: "Bank", type: "asset", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
      { id: "b", parentId: null, name: "Rent", type: "expense", currency: "USD", isPlaceholder: false, updatedAt: NOW },
    ];
    book.recurrences = [ruleOn("a", "b")];
    expect(unwrapErr(validateBook(book)).code).toBe("BOOK_INVALID");
  });

  it("accepts a well-formed rule", () => {
    const book = emptyBook();
    book.accounts = [
      { id: "a", parentId: null, name: "Bank", type: "asset", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
      { id: "b", parentId: null, name: "Rent", type: "expense", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
    ];
    book.recurrences = [ruleOn("a", "b")];
    expect(unwrap(validateBook(book))).toBe(true);
  });

  // validateBook's contract is to return a Result, never throw — a corrupted Drive
  // file can carry a null element inside a recurrence's `lines`, and the account/
  // currency checks below dereference every line directly.
  it("reports a null recurrence line element instead of throwing", () => {
    const book = emptyBook();
    book.accounts = [
      { id: "a", parentId: null, name: "Bank", type: "asset", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
    ];
    const broken = structuredClone(ruleOn("a", "a"));
    (broken.lines as unknown[]).push(null);
    book.recurrences = [broken];
    const error = unwrapErr(validateBook(book));
    const messages = (error.details?.violations as Array<{ message: string }>).map((v) => v.message);
    expect(messages).toContain("Invalid recurrence line element");
  });
});
