import { describe, expect, it } from "vitest";
import { createAccount, updateAccount } from "../../src/kernel/accounts";
import { removeBudget, setBudget } from "../../src/kernel/budgets";
import { createBook } from "../../src/kernel/create-book";
import { postEntry, updateEntry } from "../../src/kernel/journal";
import { recordOpeningBalance } from "../../src/kernel/opening";
import {
  createRecurrence,
  deferOccurrence,
  setRecurrencePaused,
  skipOccurrence,
  updateRecurrence,
} from "../../src/kernel/recurrences";
import type { Book } from "../../src/kernel/types";
import { NOW, LATER, unwrap } from "../helpers";

const TODAY = "2026-06-15";

const ruleInput = {
  description: "Rent",
  fromAccountId: "bank",
  lines: [{ toAccountId: "rent", amount: 300000 }],
  every: 1,
  unit: "month" as const,
  startDate: "2026-04-01",
  endDate: null,
};

function withRule(): Book {
  const book = unwrap(createBook({ name: "Household", homeCurrency: "ILS" }, NOW));
  book.accounts = [
    { id: "bank", parentId: null, name: "Bank", type: "asset", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
    { id: "rent", parentId: null, name: "Rent", type: "expense", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
  ];
  return unwrap(createRecurrence(book, { ...ruleInput, id: "r1" }, NOW));
}

describe("recurrence commands that change nothing", () => {
  it("re-pausing a paused rule returns the same book and keeps the first pause's stamp", () => {
    const paused = unwrap(setRecurrencePaused(withRule(), "r1", true, TODAY, NOW));
    const again = unwrap(setRecurrencePaused(paused, "r1", true, "2026-07-01", LATER));
    expect(again).toBe(paused);
    expect(again.recurrences[0].updatedAt).toBe(NOW);
    expect(again.recurrences[0].pausedAt).toBe(TODAY);
  });

  it("resuming a rule that is not paused returns the same book", () => {
    const book = withRule();
    expect(unwrap(setRecurrencePaused(book, "r1", false, TODAY, LATER))).toBe(book);
  });

  it("skipping a date already skipped returns the same book", () => {
    const once = unwrap(skipOccurrence(withRule(), "r1", "2026-05-01", TODAY, NOW));
    const twice = unwrap(skipOccurrence(once, "r1", "2026-05-01", TODAY, LATER));
    expect(twice).toBe(once);
    expect(twice.recurrences[0].updatedAt).toBe(NOW);
  });

  it("deferring a date already deferred returns the same book", () => {
    const once = unwrap(deferOccurrence(withRule(), "r1", "2026-05-01", TODAY, NOW));
    expect(unwrap(deferOccurrence(once, "r1", "2026-05-01", TODAY, LATER))).toBe(once);
  });

  it("updating a rule with its own current values returns the same book", () => {
    const book = withRule();
    expect(unwrap(updateRecurrence(book, { ...ruleInput, id: "r1" }, LATER))).toBe(book);
  });

  it("a skip whose window pruning drops an old date is a change and is stamped", () => {
    // The skipped list keeps only dates inside the 12-month window before `today`
    // (RECURRENCE_WINDOW_MONTHS). Seed a date outside it, then skip a new one: the
    // pruning changes the record, so this is a change, not a no-op.
    const book = withRule();
    book.recurrences[0] = { ...book.recurrences[0], skipped: ["2025-01-01"] };
    const later = unwrap(skipOccurrence(book, "r1", "2026-05-01", "2026-06-15", LATER));
    expect(later).not.toBe(book);
    expect(later.recurrences[0].skipped).toEqual(["2026-05-01"]);
    expect(later.recurrences[0].updatedAt).toBe(LATER);
  });

  it("a real pause is stamped", () => {
    const book = withRule();
    const paused = unwrap(setRecurrencePaused(book, "r1", true, TODAY, LATER));
    expect(paused).not.toBe(book);
    expect(paused.recurrences[0].updatedAt).toBe(LATER);
  });
});

function household() {
  let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
  book = unwrap(createAccount(book, { parentId: null, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false }, NOW));
  book = unwrap(createAccount(book, { parentId: null, name: "Expenses", type: "expense", currency: "ILS", isPlaceholder: true }, NOW));
  const cash = book.accounts[0].id;
  const expenses = book.accounts[1].id;
  book = unwrap(createAccount(book, { parentId: expenses, name: "Food", type: "expense", currency: "ILS", isPlaceholder: false }, NOW));
  const food = book.accounts[2].id;
  book = unwrap(
    postEntry(book, {
      date: "2026-08-10",
      description: "Groceries",
      postings: [
        { accountId: food, side: "debit", amount: 500 },
        { accountId: cash, side: "credit", amount: 500 },
      ],
    }, NOW),
  );
  return { book, cash, expenses, food, entryId: book.journal[0].id };
}

describe("record commands that change nothing", () => {
  it("updateAccount with the current name returns the same book", () => {
    const { book, food } = household();
    expect(unwrap(updateAccount(book, { id: food, name: "Food" }, LATER))).toBe(book);
    expect(book.accounts[2].updatedAt).toBe(NOW);
  });

  it("updateAccount trims before comparing, so a padded current name is still a no-op", () => {
    const { book, food } = household();
    expect(unwrap(updateAccount(book, { id: food, name: "  Food  " }, LATER))).toBe(book);
  });

  it("updateAccount with a new name is stamped", () => {
    const { book, food } = household();
    const renamed = unwrap(updateAccount(book, { id: food, name: "Groceries" }, LATER));
    expect(renamed).not.toBe(book);
    expect(renamed.accounts[2].updatedAt).toBe(LATER);
  });

  it("updateEntry with equal postings in fresh objects returns the same book", () => {
    const { book, entryId } = household();
    const postings = book.journal[0].postings.map((p) => ({ ...p }));
    expect(
      unwrap(updateEntry(book, { id: entryId, description: "Groceries", postings }, LATER)),
    ).toBe(book);
  });

  it("updateEntry with a new description is stamped", () => {
    const { book, entryId } = household();
    const next = unwrap(updateEntry(book, { id: entryId, description: "Market" }, LATER));
    expect(next).not.toBe(book);
    expect(next.journal[0].updatedAt).toBe(LATER);
  });

  it("setBudget with the current limit returns the same book", () => {
    const { book, food } = household();
    const key = { accountId: food, period: "month" as const, currency: "ILS" as const };
    const withBudget = unwrap(setBudget(book, { ...key, limit: 10000 }, NOW));
    expect(unwrap(setBudget(withBudget, { ...key, limit: 10000 }, LATER))).toBe(withBudget);
  });

  it("setBudget with an equal record still clears a lingering tombstone, and stamps", () => {
    const { book, food } = household();
    const key = { accountId: food, period: "month" as const, currency: "ILS" as const };
    const withBudget = unwrap(setBudget(book, { ...key, limit: 10000 }, NOW));
    // A budget tombstone beside a live budget of the same key can only come out of a
    // merge; build the shape by hand.
    const removed = unwrap(removeBudget(withBudget, key, NOW));
    const lingering = { ...removed, budgets: [...withBudget.budgets] };
    const next = unwrap(setBudget(lingering, { ...key, limit: 10000 }, LATER));
    expect(next).not.toBe(lingering);
    expect(next.tombstones.some((t) => t.kind === "budget")).toBe(false);
    expect(next.budgets[0].updatedAt).toBe(LATER);
  });

  it("setBudget with a new limit is stamped", () => {
    const { book, food } = household();
    const key = { accountId: food, period: "month" as const, currency: "ILS" as const };
    const withBudget = unwrap(setBudget(book, { ...key, limit: 10000 }, NOW));
    const raised = unwrap(setBudget(withBudget, { ...key, limit: 20000 }, LATER));
    expect(raised).not.toBe(withBudget);
    expect(raised.budgets[0].updatedAt).toBe(LATER);
  });

  it("recordOpeningBalance of 0 on an account with no opening entry returns the same book", () => {
    const { book, cash } = household();
    expect(
      unwrap(recordOpeningBalance(book, { accountId: cash, amount: 0, date: "2026-01-01" }, LATER)),
    ).toBe(book);
  });
});
