import { describe, expect, it } from "vitest";
import { createBook } from "../../src/kernel/create-book";
import { journalRows } from "../../src/app/journal-rows";
import type { Book, JournalEntry } from "../../src/kernel/types";
import type { DueRow } from "../../src/service/ledger-app";
import { unwrap, NOW } from "../helpers";

function seeded(): Book {
  const book = unwrap(createBook({ name: "Household", homeCurrency: "ILS" }, NOW));
  book.accounts = [
    { id: "rent", parentId: null, name: "Rent", type: "expense", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
    { id: "bank", parentId: null, name: "Bank", type: "asset", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
    { id: "gym", parentId: null, name: "Gym", type: "expense", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
  ];
  return book;
}

const postings = [
  { accountId: "rent", side: "debit" as const, amount: 100 },
  { accountId: "bank", side: "credit" as const, amount: 100 },
];

function entry(id: string, date: string): JournalEntry {
  return { id, date, description: "Rent", kind: "standard", postings, updatedAt: NOW };
}

function due(date: string, accountId = "rent"): DueRow {
  return {
    ruleId: "r1",
    date,
    entryId: `rec:r1:${date}`,
    deferred: false,
    description: "Rent",
    currency: "ILS",
    total: 100,
    preview: {
      id: `rec:r1:${date}`,
      date,
      description: "Rent",
      kind: "standard",
      postings: [
        { accountId, side: "debit", amount: 100 },
        { accountId: "bank", side: "credit", amount: 100 },
      ],
      updatedAt: NOW,
    },
  };
}

describe("journalRows", () => {
  it("interleaves pending rows with real entries, newest first", () => {
    const rows = journalRows([entry("e1", "2026-05-10"), entry("e2", "2026-05-01")], [due("2026-05-05")], seeded(), undefined);
    expect(rows.map((r) => (r.kind === "entry" ? r.entry.id : r.due.entryId))).toEqual([
      "e1",
      "rec:r1:2026-05-05",
      "e2",
    ]);
  });

  it("applies the date filter to pending rows too", () => {
    const rows = journalRows([], [due("2026-04-05"), due("2026-05-05")], seeded(), {
      from: "2026-05-01",
      to: "2026-05-31",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind === "pending" ? rows[0].due.date : null).toBe("2026-05-05");
  });

  it("applies the account filter to pending rows too", () => {
    const rows = journalRows([], [due("2026-05-05", "gym")], seeded(), { accountId: "rent" });
    expect(rows).toEqual([]);
  });
});
