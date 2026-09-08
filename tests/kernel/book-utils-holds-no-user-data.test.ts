import { describe, expect, it } from "vitest";
import { createAccount, deleteAccount } from "../../src/kernel/accounts";
import { setBudget } from "../../src/kernel/budgets";
import { createBook } from "../../src/kernel/create-book";
import { holdsNoUserData } from "../../src/kernel/book-utils";
import { postEntry } from "../../src/kernel/journal";
import { createRecurrence } from "../../src/kernel/recurrences";
import type { Book } from "../../src/kernel/types";
import { NOW, unwrap } from "../helpers";

/** The four top-level placeholder groups `createHousehold` seeds, without going through
 * the service layer (which would drag i18n in for the names). */
function seeded(): Book {
  let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
  for (const [name, type] of [
    ["Assets", "asset"],
    ["Liabilities", "liability"],
    ["Income", "income"],
    ["Expenses", "expense"],
  ] as const) {
    book = unwrap(
      createAccount(book, { parentId: null, name, type, currency: "ILS", isPlaceholder: true }, NOW),
    );
  }
  return book;
}

function rootId(book: Book, name: string): string {
  const account = book.accounts.find((a) => a.name === name);
  if (!account) throw new Error(`no root named ${name}`);
  return account.id;
}

/** A leaf under Assets, and a second under Expenses, for the cases that need somewhere
 * to post to or budget against. */
function withLeaves(book: Book): { book: Book; cash: string; food: string } {
  let next = unwrap(
    createAccount(
      book,
      { parentId: rootId(book, "Assets"), name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false },
      NOW,
    ),
  );
  next = unwrap(
    createAccount(
      next,
      { parentId: rootId(next, "Expenses"), name: "Food", type: "expense", currency: "ILS", isPlaceholder: false },
      NOW,
    ),
  );
  return { book: next, cash: rootId(next, "Cash"), food: rootId(next, "Food") };
}

describe("holdsNoUserData", () => {
  it("is true for the book onboarding seeds", () => {
    expect(holdsNoUserData(seeded())).toBe(true);
  });

  it("is true for a book with no accounts at all", () => {
    expect(holdsNoUserData(unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW)))).toBe(true);
  });

  it("is false once any account has a parent", () => {
    const { book } = withLeaves(seeded());
    expect(holdsNoUserData(book)).toBe(false);
  });

  it("is false for a top-level account that is not a placeholder", () => {
    const book = unwrap(
      createAccount(
        unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW)),
        { parentId: null, name: "Wallet", type: "asset", currency: "ILS", isPlaceholder: false },
        NOW,
      ),
    );
    expect(holdsNoUserData(book)).toBe(false);
  });

  it("is false once the journal holds an entry", () => {
    const { book, cash, food } = withLeaves(seeded());
    const posted = unwrap(
      postEntry(
        book,
        {
          date: "2026-09-08",
          description: "Lunch",
          postings: [
            { accountId: food, side: "debit", amount: 1000 },
            { accountId: cash, side: "credit", amount: 1000 },
          ],
        },
        NOW,
      ),
    );
    expect(holdsNoUserData(posted)).toBe(false);
  });

  it("is false once a budget exists", () => {
    const { book, food } = withLeaves(seeded());
    const budgeted = unwrap(
      setBudget(book, { accountId: food, period: "month", currency: "ILS", limit: 50000 }, NOW),
    );
    expect(holdsNoUserData(budgeted)).toBe(false);
  });

  it("is false once a recurrence rule exists", () => {
    const { book, cash, food } = withLeaves(seeded());
    const ruled = unwrap(
      createRecurrence(
        book,
        {
          description: "Rent",
          fromAccountId: cash,
          lines: [{ toAccountId: food, amount: 100000 }],
          every: 1,
          unit: "month",
          startDate: "2026-09-01",
          endDate: null,
        },
        NOW,
      ),
    );
    expect(holdsNoUserData(ruled)).toBe(false);
  });

  it("is false when only a tombstone is left behind", () => {
    const { book, cash } = withLeaves(seeded());
    const deleted = unwrap(deleteAccount(book, cash, NOW));
    expect(deleted.tombstones.length).toBeGreaterThan(0);
    expect(holdsNoUserData(deleted)).toBe(false);
  });
});
