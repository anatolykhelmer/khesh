import { describe, expect, it } from "vitest";
import { createBook } from "../../src/kernel/create-book";
import { postEntry, deleteEntry } from "../../src/kernel/journal";
import { dueOccurrences, recurrenceEntryId } from "../../src/kernel/occurrences";
import { createRecurrence } from "../../src/kernel/recurrences";
import type { Book } from "../../src/kernel/types";
import { unwrap, NOW, LATER } from "../helpers";

const TODAY = "2026-06-15";

function seeded(): Book {
  const book = unwrap(createBook({ name: "Household", homeCurrency: "ILS" }, NOW));
  book.accounts = [
    { id: "bank", parentId: null, name: "Bank", type: "asset", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
    { id: "rent", parentId: null, name: "Rent", type: "expense", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
  ];
  return book;
}

const monthly = {
  id: "r1",
  description: "Rent",
  fromAccountId: "bank",
  lines: [{ toAccountId: "rent", amount: 300000 }],
  every: 1,
  unit: "month" as const,
  startDate: "2026-04-01",
  endDate: null as string | null,
};

function withRule(overrides: Partial<typeof monthly> = {}): Book {
  return unwrap(createRecurrence(seeded(), { ...monthly, ...overrides }, NOW));
}

const rentPostings = [
  { accountId: "rent", side: "debit" as const, amount: 300000 },
  { accountId: "bank", side: "credit" as const, amount: 300000 },
];

describe("dueOccurrences", () => {
  it("lists every occurrence up to today, oldest first", () => {
    expect(dueOccurrences(withRule(), TODAY).map((o) => o.date)).toEqual([
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
    ]);
  });

  it("never offers a future occurrence", () => {
    expect(dueOccurrences(withRule({ startDate: "2026-07-01" }), TODAY)).toEqual([]);
  });

  it("stops at the end date, inclusively", () => {
    expect(dueOccurrences(withRule({ endDate: "2026-05-01" }), TODAY).map((o) => o.date)).toEqual([
      "2026-04-01",
      "2026-05-01",
    ]);
  });

  it("yields nothing while the rule is paused", () => {
    const book = withRule();
    book.recurrences[0].pausedAt = "2026-04-15";
    expect(dueOccurrences(book, TODAY)).toEqual([]);
  });

  it("drops a skipped date and flags a deferred one without hiding it", () => {
    const book = withRule();
    book.recurrences[0].skipped = ["2026-04-01"];
    book.recurrences[0].deferred = ["2026-05-01"];
    const due = dueOccurrences(book, TODAY);
    expect(due.map((o) => o.date)).toEqual(["2026-05-01", "2026-06-01"]);
    expect(due.map((o) => o.deferred)).toEqual([true, false]);
  });

  it("drops an occurrence already posted", () => {
    const book = unwrap(
      postEntry(
        withRule(),
        { id: recurrenceEntryId("r1", "2026-05-01"), date: "2026-05-01", description: "Rent", postings: rentPostings },
        NOW,
      ),
    );
    expect(dueOccurrences(book, TODAY).map((o) => o.date)).toEqual(["2026-04-01", "2026-06-01"]);
  });

  it("does not bring back an occurrence that was posted and then deleted", () => {
    const id = recurrenceEntryId("r1", "2026-05-01");
    const posted = unwrap(
      postEntry(withRule(), { id, date: "2026-05-01", description: "Rent", postings: rentPostings }, NOW),
    );
    const book = unwrap(deleteEntry(posted, id, LATER));
    expect(dueOccurrences(book, TODAY).map((o) => o.date)).toEqual(["2026-04-01", "2026-06-01"]);
  });

  it("carries the entry id each occurrence would be posted under", () => {
    expect(dueOccurrences(withRule(), TODAY)[0].entryId).toBe(recurrenceEntryId("r1", "2026-04-01"));
  });

  it("offers only the last twelve months of a very old rule", () => {
    const due = dueOccurrences(withRule({ startDate: "1990-01-10" }), TODAY);
    expect(due).toHaveLength(12);
    expect(due[0].date).toBe("2025-07-10");
    expect(due[11].date).toBe("2026-06-10");
  });

  it("sorts across rules by date", () => {
    const book = unwrap(
      createRecurrence(
        withRule(),
        { ...monthly, id: "r2", description: "Gym", startDate: "2026-04-20", lines: [{ toAccountId: "rent", amount: 10000 }] },
        NOW,
      ),
    );
    expect(dueOccurrences(book, TODAY).map((o) => `${o.date}:${o.ruleId}`)).toEqual([
      "2026-04-01:r1",
      "2026-04-20:r2",
      "2026-05-01:r1",
      "2026-05-20:r2",
      "2026-06-01:r1",
    ]);
  });
});
