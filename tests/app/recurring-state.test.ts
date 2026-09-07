import { describe, expect, it } from "vitest";
import { createBook } from "../../src/kernel/create-book";
import { createRecurrence } from "../../src/kernel/recurrences";
import { nextOccurrence, ruleRows } from "../../src/app/recurring-state";
import type { Book } from "../../src/kernel/types";
import { unwrap, NOW } from "../helpers";

const TODAY = "2026-06-15";

function withRule(overrides: Record<string, unknown> = {}): Book {
  const book = unwrap(createBook({ name: "Household", homeCurrency: "ILS" }, NOW));
  book.accounts = [
    { id: "bank", parentId: null, name: "Bank", type: "asset", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
    { id: "rent", parentId: null, name: "Rent", type: "expense", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
    { id: "food", parentId: null, name: "Food", type: "expense", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
  ];
  return unwrap(
    createRecurrence(
      book,
      {
        id: "r1",
        description: "Rent",
        fromAccountId: "bank",
        lines: [{ toAccountId: "rent", amount: 300000 }],
        every: 1,
        unit: "month",
        startDate: "2026-04-01",
        endDate: null,
        ...overrides,
      } as never,
      NOW,
    ),
  );
}

describe("nextOccurrence", () => {
  it("is the first occurrence strictly after today", () => {
    expect(nextOccurrence(withRule().recurrences[0], TODAY)).toBe("2026-07-01");
  });

  it("is null past the end date", () => {
    expect(nextOccurrence(withRule({ endDate: "2026-05-01" }).recurrences[0], TODAY)).toBeNull();
  });

  it("is the start date for a rule that has not begun", () => {
    expect(nextOccurrence(withRule({ startDate: "2026-09-01" }).recurrences[0], TODAY)).toBe("2026-09-01");
  });

  it("is the start date for a rule starting well beyond the search horizon", () => {
    const rule = withRule({ unit: "year", every: 1, startDate: "2029-06-15" }).recurrences[0];
    expect(nextOccurrence(rule, TODAY)).toBe("2029-06-15");
  });
});

describe("ruleRows", () => {
  it("summarises each rule with its total and next date", () => {
    const rows = ruleRows(withRule(), TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "r1", description: "Rent", total: 300000, currency: "ILS", next: "2026-07-01", paused: false });
  });

  it("sums a split into one figure", () => {
    const book = withRule({
      lines: [
        { toAccountId: "rent", amount: 300000 },
        { toAccountId: "food", amount: 50000 },
      ],
    });
    expect(ruleRows(book, TODAY)[0].total).toBe(350000);
  });

  it("reports a paused rule as paused and gives it no next date", () => {
    const book = withRule();
    book.recurrences[0].pausedAt = "2026-05-01";
    expect(ruleRows(book, TODAY)[0]).toMatchObject({ paused: true, next: null });
  });
});
