import { describe, expect, it } from "vitest";
import { createAccount, deleteAccount } from "../../src/kernel/accounts";
import { setBudget } from "../../src/kernel/budgets";
import { createBook } from "../../src/kernel/create-book";
import { holdsNoUserData } from "../../src/kernel/book-utils";
import { postEntry } from "../../src/kernel/journal";
import { createRecurrence } from "../../src/kernel/recurrences";
import type { Book } from "../../src/kernel/types";
import { NOW, unwrap } from "../helpers";
import { realBook } from "../helpers/book";

/** The four top-level placeholder groups `createHousehold` seeds, without going through
 * the service layer (which would drag i18n in for the names). `realBook()` already
 * builds exactly this shape. */
function seeded(): Book {
  return realBook();
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

  // Deliberate (S8): a book with no accounts at all, not even the four roots —
  // holdsNoUserData must still say yes to a book that never got past createBook.
  it("is true for a book with no accounts at all", () => {
    expect(holdsNoUserData(unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW)))).toBe(true);
  });

  it("is false once any account has a parent", () => {
    const { book } = withLeaves(seeded());
    expect(holdsNoUserData(book)).toBe(false);
  });

  // Deliberate (S8): createAccount refuses a non-placeholder top-level account now,
  // so this book is built by literal — holdsNoUserData stays defensive about a shape
  // the kernel itself can no longer produce.
  it("is false for a top-level account that is not a placeholder", () => {
    const book = realBook();
    book.accounts.push({
      id: "wallet",
      parentId: null,
      name: "Wallet",
      type: "asset",
      currency: "ILS",
      isPlaceholder: false,
      updatedAt: NOW,
    });
    expect(holdsNoUserData(book)).toBe(false);
  });

  it("is false when a placeholder account has a parent", () => {
    let book = seeded();
    const expensesId = rootId(book, "Expenses");
    book = unwrap(
      createAccount(
        book,
        { parentId: expensesId, name: "Housing", type: "expense", currency: "ILS", isPlaceholder: true },
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
