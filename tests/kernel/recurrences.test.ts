import { describe, expect, it } from "vitest";
import { createBook } from "../../src/kernel/create-book";
import { createRecurrence, deleteRecurrence, updateRecurrence } from "../../src/kernel/recurrences";
import type { Book } from "../../src/kernel/types";
import { unwrap, unwrapErr, NOW, LATER } from "../helpers";

function bookWithAccounts(): Book {
  const book = unwrap(createBook({ name: "Household", homeCurrency: "ILS" }, NOW));
  book.accounts = [
    { id: "bank", parentId: null, name: "Bank", type: "asset", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
    { id: "rent", parentId: null, name: "Rent", type: "expense", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
    { id: "food", parentId: null, name: "Food", type: "expense", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
    { id: "usd", parentId: null, name: "Dollars", type: "asset", currency: "USD", isPlaceholder: false, updatedAt: NOW },
    { id: "group", parentId: null, name: "Expenses", type: "expense", currency: "ILS", isPlaceholder: true, updatedAt: NOW },
  ];
  return book;
}

const input = {
  description: "Rent",
  fromAccountId: "bank",
  lines: [{ toAccountId: "rent", amount: 300000 }],
  every: 1,
  unit: "month" as const,
  startDate: "2026-01-01",
  endDate: null,
};

describe("createRecurrence", () => {
  it("adds a live rule with the schedule and an id", () => {
    const book = unwrap(createRecurrence(bookWithAccounts(), input, NOW));
    expect(book.recurrences).toHaveLength(1);
    const rule = book.recurrences[0];
    expect(rule.id).toMatch(/\S/);
    expect(rule.pausedAt).toBeNull();
    expect(rule.skipped).toEqual([]);
    expect(rule.deferred).toEqual([]);
    expect(rule.updatedAt).toBe(NOW);
  });

  it("honors an explicit id when provided", () => {
    const customId = "my-custom-rule-id";
    const book = unwrap(createRecurrence(bookWithAccounts(), { ...input, id: customId }, NOW));
    expect(book.recurrences).toHaveLength(1);
    expect(book.recurrences[0].id).toBe(customId);
  });

  it("refuses a duplicate id", () => {
    const customId = "my-custom-rule-id";
    let book = unwrap(createRecurrence(bookWithAccounts(), { ...input, id: customId }, NOW));
    const result = createRecurrence(book, { ...input, id: customId }, NOW);
    expect(unwrapErr(result).code).toBe("RECURRENCE_ID_DUPLICATE");
  });

  it("accepts a split across several accounts", () => {
    const book = unwrap(
      createRecurrence(
        bookWithAccounts(),
        { ...input, lines: [{ toAccountId: "rent", amount: 300000 }, { toAccountId: "food", amount: 50000 }] },
        NOW,
      ),
    );
    expect(book.recurrences[0].lines).toHaveLength(2);
  });

  it("refuses a cross-currency rule", () => {
    const result = createRecurrence(bookWithAccounts(), { ...input, fromAccountId: "usd" }, NOW);
    expect(unwrapErr(result).code).toBe("RECURRENCE_CURRENCY_MISMATCH");
  });

  it("refuses a category as an account", () => {
    const result = createRecurrence(
      bookWithAccounts(),
      { ...input, lines: [{ toAccountId: "group", amount: 100 }] },
      NOW,
    );
    expect(unwrapErr(result).code).toBe("ACCOUNT_IS_PLACEHOLDER");
  });

  it("refuses a missing account", () => {
    const result = createRecurrence(bookWithAccounts(), { ...input, fromAccountId: "nope" }, NOW);
    expect(unwrapErr(result).code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("refuses a line that targets the source account", () => {
    const result = createRecurrence(
      bookWithAccounts(),
      { ...input, lines: [{ toAccountId: "bank", amount: 100 }] },
      NOW,
    );
    expect(unwrapErr(result).code).toBe("ENTRY_TOO_FEW_ACCOUNTS");
  });

  it("refuses a repeated target account", () => {
    const result = createRecurrence(
      bookWithAccounts(),
      { ...input, lines: [{ toAccountId: "rent", amount: 100 }, { toAccountId: "rent", amount: 200 }] },
      NOW,
    );
    expect(unwrapErr(result).code).toBe("ENTRY_TOO_FEW_ACCOUNTS");
  });

  it("refuses no lines at all", () => {
    const result = createRecurrence(bookWithAccounts(), { ...input, lines: [] }, NOW);
    expect(unwrapErr(result).code).toBe("ENTRY_TOO_FEW_ACCOUNTS");
  });

  it("refuses a non-positive or fractional amount", () => {
    for (const amount of [0, -5, 12.5]) {
      const result = createRecurrence(
        bookWithAccounts(),
        { ...input, lines: [{ toAccountId: "rent", amount }] },
        NOW,
      );
      expect(unwrapErr(result).code).toBe("ENTRY_AMOUNT_INVALID");
    }
  });

  it("refuses an interval below one or fractional", () => {
    for (const every of [0, -1, 1.5]) {
      const result = createRecurrence(bookWithAccounts(), { ...input, every }, NOW);
      expect(unwrapErr(result).code).toBe("RECURRENCE_SCHEDULE_INVALID");
    }
  });

  it("refuses a malformed start date and an end date before it", () => {
    expect(unwrapErr(createRecurrence(bookWithAccounts(), { ...input, startDate: "2026-02-30" }, NOW)).code).toBe(
      "RECURRENCE_SCHEDULE_INVALID",
    );
    expect(unwrapErr(createRecurrence(bookWithAccounts(), { ...input, endDate: "2025-12-31" }, NOW)).code).toBe(
      "RECURRENCE_SCHEDULE_INVALID",
    );
  });
});

describe("updateRecurrence", () => {
  it("keeps the id and the occurrence bookkeeping while changing the template", () => {
    let book = unwrap(createRecurrence(bookWithAccounts(), input, NOW));
    const id = book.recurrences[0].id;
    book.recurrences[0].skipped = ["2026-03-01"];
    book = unwrap(
      updateRecurrence(book, { ...input, id, description: "Rent (raised)", lines: [{ toAccountId: "rent", amount: 320000 }] }, LATER),
    );
    expect(book.recurrences[0].id).toBe(id);
    expect(book.recurrences[0].description).toBe("Rent (raised)");
    expect(book.recurrences[0].lines[0].amount).toBe(320000);
    expect(book.recurrences[0].skipped).toEqual(["2026-03-01"]);
    expect(book.recurrences[0].updatedAt).toBe(LATER);
  });

  it("refuses an unknown id", () => {
    const result = updateRecurrence(bookWithAccounts(), { ...input, id: "nope" }, NOW);
    expect(unwrapErr(result).code).toBe("RECURRENCE_NOT_FOUND");
  });
});

describe("deleteRecurrence", () => {
  it("removes the rule and leaves a tombstone carrying it", () => {
    const created = unwrap(createRecurrence(bookWithAccounts(), input, NOW));
    const id = created.recurrences[0].id;
    const book = unwrap(deleteRecurrence(created, id, LATER));
    expect(book.recurrences).toEqual([]);
    expect(book.tombstones).toHaveLength(1);
    expect(book.tombstones[0].kind).toBe("recurrence");
    expect(book.tombstones[0].key).toBe(id);
    expect(book.tombstones[0].deletedAt).toBe(LATER);
  });

  it("refuses an unknown id", () => {
    expect(unwrapErr(deleteRecurrence(bookWithAccounts(), "nope", NOW)).code).toBe("RECURRENCE_NOT_FOUND");
  });
});
