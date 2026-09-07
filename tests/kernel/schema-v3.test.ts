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

/** Bank (asset) and Rent (expense), both ILS — a rule between them is well-formed,
 * so every schedule/placeholder/duplicate case below only ever breaks the one thing
 * it patches in. */
function bookWithTwoAccounts(): Book {
  const book = emptyBook();
  book.accounts = [
    { id: "a", parentId: null, name: "Bank", type: "asset", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
    { id: "b", parentId: null, name: "Rent", type: "expense", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
  ];
  return book;
}

/** Same pattern as tests/kernel/validate-v2.test.ts's `violations`/`codes` helpers:
 * validateBook always wraps every failure in the same BOOK_INVALID envelope, so only
 * digging into `details.violations` can tell one rejection reason from another. */
function violations(result: ReturnType<typeof validateBook>) {
  const error = unwrapErr(result);
  return error.details?.violations as Array<{
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }>;
}

function codes(result: ReturnType<typeof validateBook>) {
  return violations(result).map((v) => v.code);
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
    const book = bookWithTwoAccounts();
    book.accounts[1] = { ...book.accounts[1], currency: "USD" };
    book.recurrences = [ruleOn("a", "b")];
    expect(codes(validateBook(book))).toContain("RECURRENCE_CURRENCY_MISMATCH");
  });

  it("accepts a well-formed rule", () => {
    const book = bookWithTwoAccounts();
    book.recurrences = [ruleOn("a", "b")];
    expect(unwrap(validateBook(book))).toBe(true);
  });

  it("rejects a rule that posts to a placeholder account", () => {
    const book = bookWithTwoAccounts();
    book.accounts[1] = { ...book.accounts[1], isPlaceholder: true };
    book.recurrences = [ruleOn("a", "b")];
    expect(codes(validateBook(book))).toContain("ACCOUNT_IS_PLACEHOLDER");
  });

  // Mirrors createRecurrence's own line checks (tests/kernel/recurrences.test.ts) — a
  // hand-edited snapshot must not carry a structurally illegal rule past import, Drive
  // sync or the IndexedDB load just because it skipped the command that normally guards
  // this.
  it("rejects a rule whose line targets its own source account", () => {
    const book = bookWithTwoAccounts();
    book.recurrences = [ruleOn("a", "a")];
    expect(codes(validateBook(book))).toContain("ENTRY_TOO_FEW_ACCOUNTS");
  });

  it("rejects a rule with a repeated target account", () => {
    const book = bookWithTwoAccounts();
    book.recurrences = [
      {
        ...ruleOn("a", "b"),
        lines: [
          { toAccountId: "b", amount: 300000 },
          { toAccountId: "b", amount: 100000 },
        ],
      },
    ];
    expect(codes(validateBook(book))).toContain("ENTRY_TOO_FEW_ACCOUNTS");
  });

  it("rejects two rules sharing an id", () => {
    const book = bookWithTwoAccounts();
    book.recurrences = [ruleOn("a", "b"), { ...ruleOn("a", "b"), description: "Rent (2)" }];
    expect(codes(validateBook(book))).toContain("RECURRENCE_ID_DUPLICATE");
  });

  // One case per schedule field the brief added, each pinned to
  // RECURRENCE_SCHEDULE_INVALID rather than the generic BOOK_INVALID wrapper —
  // otherwise a typo that made the whole block reject unconditionally would pass
  // just as well as a correct check.
  it.each([
    ["a non-positive every", { every: 0 }],
    ["an unrecognized unit", { unit: "day" as unknown as Recurrence["unit"] }],
    ["a malformed startDate", { startDate: "2026-02-30" }],
    ["an endDate before startDate", { endDate: "2025-12-31" }],
    ["a malformed pausedAt", { pausedAt: "not-a-date" }],
    ["a non-date in skipped", { skipped: ["not-a-date"] }],
  ] as Array<[string, Partial<Recurrence>]>)("rejects a rule with %s", (_label, patch) => {
    const book = bookWithTwoAccounts();
    book.recurrences = [{ ...ruleOn("a", "b"), ...patch }];
    expect(codes(validateBook(book))).toContain("RECURRENCE_SCHEDULE_INVALID");
  });

  // validateBook's contract is to return a Result, never throw — a corrupted Drive
  // file can carry a null element inside a recurrence's `lines`, and the account/
  // currency checks below dereference every line directly.
  it("reports a null recurrence line element instead of throwing", () => {
    const book = bookWithTwoAccounts();
    const broken = structuredClone(ruleOn("a", "b"));
    (broken.lines as unknown[]).push(null);
    book.recurrences = [broken];
    expect(violations(validateBook(book)).map((v) => v.message)).toContain(
      "Invalid recurrence line element",
    );
  });

  // The new from/duplicate-target checks dereference `line.toAccountId` directly, once
  // past the "well-shaped" guard above — a line missing that field must still be reported
  // rather than throwing.
  it("does not throw when a well-shaped line lacks toAccountId", () => {
    const book = bookWithTwoAccounts();
    const broken = structuredClone(ruleOn("a", "b"));
    (broken.lines as unknown[])[0] = { amount: 300000 };
    book.recurrences = [broken];
    expect(() => validateBook(book)).not.toThrow();
    expect(unwrapErr(validateBook(book)).code).toBe("BOOK_INVALID");
  });
});
