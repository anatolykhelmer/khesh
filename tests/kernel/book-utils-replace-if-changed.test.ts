import { describe, expect, it } from "vitest";
import { replaceIfChanged } from "../../src/kernel/book-utils";
import { createBook } from "../../src/kernel/create-book";
import type { Book } from "../../src/kernel/types";
import { NOW, LATER, unwrap } from "../helpers";

function seeded(): Book {
  const book = unwrap(createBook({ name: "Household", homeCurrency: "ILS" }, NOW));
  book.accounts = [
    { id: "bank", parentId: null, name: "Bank", type: "asset", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
  ];
  return book;
}

describe("replaceIfChanged", () => {
  it("returns the same book when the candidate equals the record ignoring updatedAt", () => {
    const book = seeded();
    const candidate = { ...book.accounts[0], updatedAt: LATER };
    const result = replaceIfChanged(book, "accounts", 0, candidate, LATER);
    expect(result).toBe(book);
    expect(book.accounts[0].updatedAt).toBe(NOW);
  });

  it("returns a clone with the candidate stamped when a field differs", () => {
    const book = seeded();
    const result = replaceIfChanged(book, "accounts", 0, { ...book.accounts[0], name: "Wallet" }, LATER);
    expect(result).not.toBe(book);
    expect(result.accounts[0]).toEqual({ ...book.accounts[0], name: "Wallet", updatedAt: LATER });
    expect(book.accounts[0].name).toBe("Bank");
  });

  it("compares structurally, not by reference, and ignores key order", () => {
    const book = seeded();
    const { id, parentId, name, type, currency, isPlaceholder } = book.accounts[0];
    const reordered = { updatedAt: LATER, isPlaceholder, currency, type, name, parentId, id };
    expect(replaceIfChanged(book, "accounts", 0, reordered, LATER)).toBe(book);
  });

  it("does not alias the candidate's nested arrays into the new book", () => {
    const book = seeded();
    book.recurrences = [
      {
        id: "r1",
        description: "Rent",
        fromAccountId: "bank",
        lines: [{ toAccountId: "bank", amount: 1 }],
        every: 1,
        unit: "month",
        startDate: "2026-01-01",
        endDate: null,
        pausedAt: null,
        skipped: [],
        deferred: [],
        updatedAt: NOW,
      },
    ];
    const candidate = { ...book.recurrences[0], pausedAt: "2026-06-01" };
    const result = replaceIfChanged(book, "recurrences", 0, candidate, LATER);
    expect(result.recurrences[0].skipped).not.toBe(candidate.skipped);
    expect(result.recurrences[0].pausedAt).toBe("2026-06-01");
    expect(result.recurrences[0].updatedAt).toBe(LATER);
  });
});
