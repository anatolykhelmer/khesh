import { describe, expect, it } from "vitest";
import { createBook } from "../../src/kernel/create-book";
import { journalScope, matchesJournalFilter } from "../../src/kernel/queries";
import type { Book } from "../../src/kernel/types";
import { unwrap, NOW } from "../helpers";

function seeded(): Book {
  const book = unwrap(createBook({ name: "Household", homeCurrency: "ILS" }, NOW));
  book.accounts = [
    { id: "exp", parentId: null, name: "Expenses", type: "expense", currency: "ILS", isPlaceholder: true, updatedAt: NOW },
    { id: "rent", parentId: "exp", name: "Rent", type: "expense", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
    { id: "bank", parentId: null, name: "Bank", type: "asset", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
  ];
  return book;
}

const entry = {
  date: "2026-05-10",
  postings: [
    { accountId: "rent", side: "debit" as const, amount: 100 },
    { accountId: "bank", side: "credit" as const, amount: 100 },
  ],
};

describe("matchesJournalFilter", () => {
  it("passes everything when there is no filter", () => {
    expect(matchesJournalFilter(entry, undefined, null)).toBe(true);
  });

  it("bounds by date, inclusively", () => {
    expect(matchesJournalFilter(entry, { from: "2026-05-01", to: "2026-05-31" }, null)).toBe(true);
    expect(matchesJournalFilter(entry, { from: "2026-06-01" }, null)).toBe(false);
    expect(matchesJournalFilter(entry, { to: "2026-05-09" }, null)).toBe(false);
  });

  it("treats a group as its whole subtree", () => {
    const book = seeded();
    expect(matchesJournalFilter(entry, undefined, journalScope(book, "exp"))).toBe(true);
    expect(matchesJournalFilter(entry, undefined, journalScope(book, "bank"))).toBe(true);
    const other = { ...entry, postings: [{ accountId: "bank", side: "debit" as const, amount: 1 }] };
    expect(matchesJournalFilter(other, undefined, journalScope(book, "exp"))).toBe(false);
  });
});
