import { describe, expect, it } from "vitest";
import { deleteAccount } from "../../src/kernel/accounts";
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
    expect(merged.tombstones.map((t) => `${t.kind}|${t.key}`)).toEqual(["recurrence|r1"]);
    expect(unwrap(validateBook(merged))).toBe(true);
  });

  it("leaves a tombstone for the rule it drops, so the delete stops coming back", () => {
    // The same shape as the budget half of this in `merge.test.ts`: B deletes the rule
    // at the instant A last wrote it, so `later` hands the live/dead tie to A's live copy
    // and discards B's tombstone — then rung 7 drops that copy, because B also moved an
    // account it touches to another currency. With nothing written in its place the
    // merged book holds no claim on `r1` at all, and re-merging B pulls B's tombstone
    // back in: `mergeBooks(mergeBooks(a, b), b)` stops being `mergeBooks(a, b)`.
    const base = unwrap(createRecurrence(seeded(), { ...input, id: "r1" }, NOW));
    const a = base;
    const b = unwrap(deleteRecurrence(base, "r1", NOW));
    b.accounts = b.accounts.map((account) =>
      account.id === "rent" ? { ...account, currency: "USD", updatedAt: LATER } : account,
    );

    const merged = unwrap(mergeBooks(a, b));
    expect(merged.recurrences).toEqual([]);
    expect(merged.tombstones.map((t) => `${t.kind}|${t.key}`)).toEqual(["recurrence|r1"]);
    // Derived from the rule the rung dropped, one millisecond on, so it outranks the
    // copy A still holds instead of tying with it.
    expect(merged.tombstones[0].deletedAt).toBe("2026-09-02T10:00:00.001Z");
    expect(unwrap(mergeBooks(b, a))).toEqual(merged);
    expect(unwrap(mergeBooks(merged, a))).toEqual(merged);
    expect(unwrap(mergeBooks(merged, b))).toEqual(merged);
    expect(unwrap(validateBook(merged))).toBe(true);
  });

  it("restores an account a surviving rule still references", () => {
    const base = seeded();
    // Device A deletes "rent" without ever seeing the rule; device B creates a rule
    // that posts to it and never touches the account. Rung 1 must restore "rent" from
    // A's tombstone so the rule B still holds keeps referencing a live account.
    const a = unwrap(deleteAccount(base, "rent", LATER));
    const b = unwrap(createRecurrence(base, { ...input, id: "r1" }, NOW));
    const merged = unwrap(mergeBooks(a, b));
    expect(merged.accounts.some((account) => account.id === "rent")).toBe(true);
    expect(merged.recurrences.map((r) => r.id)).toEqual(["r1"]);
    // A resurrected record must not leave its tombstone behind — validateBook rejects
    // that shadowing.
    expect(merged.tombstones.some((t) => t.kind === "account" && t.key === "rent")).toBe(false);
    expect(unwrap(validateBook(merged))).toBe(true);
  });

  it("gives the same fingerprint whichever order the books merge in", () => {
    const a = unwrap(createRecurrence(seeded(), { ...input, id: "r1" }, NOW));
    const b = unwrap(createRecurrence(seeded(), { ...input, id: "r2", description: "Gym" }, NOW));
    expect(unwrap(mergeBooks(a, b))).toEqual(unwrap(mergeBooks(b, a)));
  });
});
