import { describe, expect, it } from "vitest";
import { createBook } from "../../src/kernel/create-book";
import { deleteEntry, postEntry } from "../../src/kernel/journal";
import { mergeBooks } from "../../src/kernel/merge";
import { recurrenceEntryId } from "../../src/kernel/occurrences";
import { validateBook } from "../../src/kernel/validate";
import type { Book } from "../../src/kernel/types";
import { unwrap, unwrapErr, NOW, LATER } from "../helpers";

function seeded(): Book {
  const book = unwrap(createBook({ name: "Household", homeCurrency: "ILS" }, NOW));
  book.accounts = [
    { id: "bank", parentId: null, name: "Bank", type: "asset", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
    { id: "rent", parentId: null, name: "Rent", type: "expense", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
  ];
  return book;
}

const rentPostings = [
  { accountId: "rent", side: "debit" as const, amount: 300000 },
  { accountId: "bank", side: "credit" as const, amount: 300000 },
];

describe("recurrenceEntryId", () => {
  it("builds one stable id from a rule and an occurrence date", () => {
    expect(recurrenceEntryId("r1", "2026-06-01")).toBe("rec:r1:2026-06-01");
  });
});

describe("postEntry with an explicit id", () => {
  it("uses the id it was given", () => {
    const id = recurrenceEntryId("r1", "2026-06-01");
    const book = unwrap(postEntry(seeded(), { id, date: "2026-06-01", description: "Rent", postings: rentPostings }, NOW));
    expect(book.journal[0].id).toBe(id);
  });

  it("still generates an id when none is given", () => {
    const book = unwrap(postEntry(seeded(), { date: "2026-06-01", description: "Rent", postings: rentPostings }, NOW));
    expect(book.journal[0].id).toMatch(/\S/);
  });

  it("refuses an id already in the journal", () => {
    const id = recurrenceEntryId("r1", "2026-06-01");
    const once = unwrap(postEntry(seeded(), { id, date: "2026-06-01", description: "Rent", postings: rentPostings }, NOW));
    expect(unwrapErr(postEntry(once, { id, date: "2026-06-01", description: "Rent", postings: rentPostings }, LATER)).code).toBe(
      "ENTRY_ID_DUPLICATE",
    );
  });

  it("clears a tombstone left by an earlier delete of the same id", () => {
    const id = recurrenceEntryId("r1", "2026-06-01");
    const posted = unwrap(postEntry(seeded(), { id, date: "2026-06-01", description: "Rent", postings: rentPostings }, NOW));
    const removed = unwrap(deleteEntry(posted, id, LATER));
    const again = unwrap(postEntry(removed, { id, date: "2026-06-01", description: "Rent", postings: rentPostings }, LATER));
    expect(again.tombstones.filter((t) => t.kind === "entry" && t.key === id)).toEqual([]);
    expect(unwrap(validateBook(again))).toBe(true);
  });
});

describe("two devices confirming the same occurrence", () => {
  it("merge to exactly one entry", () => {
    const id = recurrenceEntryId("r1", "2026-06-01");
    const a = unwrap(postEntry(seeded(), { id, date: "2026-06-01", description: "Rent", postings: rentPostings }, NOW));
    const b = unwrap(postEntry(seeded(), { id, date: "2026-06-01", description: "Rent", postings: rentPostings }, LATER));
    const merged = unwrap(mergeBooks(a, b));
    expect(merged.journal).toHaveLength(1);
    expect(merged.journal[0].id).toBe(id);
    expect(unwrap(validateBook(merged))).toBe(true);
  });
});
