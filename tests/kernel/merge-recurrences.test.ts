import { describe, expect, it } from "vitest";
import { mergeBooks } from "../../src/kernel/merge";
import { createBook } from "../../src/kernel/create-book";
import { createRecurrence, deleteRecurrence, updateRecurrence } from "../../src/kernel/recurrences";
import { validateBook } from "../../src/kernel/validate";
import type { Book } from "../../src/kernel/types";
import { unwrap, NOW, LATER } from "../helpers";

function seeded(): Book {
  const book = unwrap(createBook({ name: "Household", homeCurrency: "ILS" }, NOW));
  book.accounts = [
    { id: "bank", parentId: null, name: "Bank", type: "asset", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
    { id: "rent", parentId: null, name: "Rent", type: "expense", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
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

describe("merging recurrences", () => {
  it("carries a rule that exists on one side only", () => {
    const a = unwrap(createRecurrence(seeded(), { ...input, id: "r1" }, NOW));
    const merged = unwrap(mergeBooks(a, seeded()));
    expect(merged.recurrences.map((r) => r.id)).toEqual(["r1"]);
    expect(unwrap(validateBook(merged))).toBe(true);
  });

  it("keeps the newer edit of the same rule, in either argument order", () => {
    const base = unwrap(createRecurrence(seeded(), { ...input, id: "r1" }, NOW));
    const a = unwrap(updateRecurrence(base, { ...input, id: "r1", description: "Old" }, NOW));
    const b = unwrap(updateRecurrence(base, { ...input, id: "r1", description: "New" }, LATER));
    expect(unwrap(mergeBooks(a, b)).recurrences[0].description).toBe("New");
    expect(unwrap(mergeBooks(b, a)).recurrences[0].description).toBe("New");
  });

  it("lets a delete beat a concurrent, older edit", () => {
    const base = unwrap(createRecurrence(seeded(), { ...input, id: "r1" }, NOW));
    const edited = unwrap(updateRecurrence(base, { ...input, id: "r1", description: "Edited" }, NOW));
    const deleted = unwrap(deleteRecurrence(base, "r1", LATER));
    const merged = unwrap(mergeBooks(edited, deleted));
    expect(merged.recurrences).toEqual([]);
    expect(merged.tombstones.some((t) => t.kind === "recurrence" && t.key === "r1")).toBe(true);
    expect(unwrap(validateBook(merged))).toBe(true);
  });

  it("drops a rule whose accounts no longer share one currency", () => {
    const a = unwrap(createRecurrence(seeded(), { ...input, id: "r1" }, NOW));
    const b = seeded();
    // The other device retyped the target account into a different currency, which is
    // legal there because it holds no postings.
    b.accounts = b.accounts.map((account) =>
      account.id === "rent" ? { ...account, currency: "USD", updatedAt: LATER } : account,
    );
    const merged = unwrap(mergeBooks(a, b));
    expect(merged.recurrences).toEqual([]);
    expect(unwrap(validateBook(merged))).toBe(true);
  });

  it("gives the same fingerprint whichever order the books merge in", () => {
    const a = unwrap(createRecurrence(seeded(), { ...input, id: "r1" }, NOW));
    const b = unwrap(createRecurrence(seeded(), { ...input, id: "r2", description: "Gym" }, NOW));
    expect(unwrap(mergeBooks(a, b))).toEqual(unwrap(mergeBooks(b, a)));
  });
});
