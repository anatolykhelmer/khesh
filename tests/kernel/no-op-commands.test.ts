import { describe, expect, it } from "vitest";
import { createBook } from "../../src/kernel/create-book";
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
