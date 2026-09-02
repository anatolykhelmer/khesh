import { describe, expect, it } from "vitest";
import { ancestorsOf } from "../../src/kernel/book-utils";
import { periodBreakdown } from "../../src/kernel/queries";
import type { Book } from "../../src/kernel/types";
import { NOW } from "../helpers";

function makeBook(accounts: Book["accounts"]): Book {
  return {
    schemaVersion: 2,
    name: "Probe",
    homeCurrency: "ILS",
    metaUpdatedAt: NOW,
    accounts,
    journal: [],
    budgets: [],
    tombstones: [],
  };
}

const linear = makeBook([
  { id: "root", parentId: null, name: "Expenses", type: "expense", currency: "ILS", isPlaceholder: true, updatedAt: NOW },
  { id: "mid", parentId: "root", name: "Food", type: "expense", currency: "ILS", isPlaceholder: true, updatedAt: NOW },
  { id: "leaf", parentId: "mid", name: "Cafes", type: "expense", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
]);

// A leaf hanging off a parent cycle (A -> B -> A). Only reachable in a book that
// skipped validateBook, but the walk must still terminate. The subject is a leaf so
// `descendants` is never entered — this isolates the upward walk.
const cyclic = makeBook([
  { id: "leaf", parentId: "A", name: "Leaf", type: "expense", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
  { id: "A", parentId: "B", name: "A", type: "expense", currency: "ILS", isPlaceholder: true, updatedAt: NOW },
  { id: "B", parentId: "A", name: "B", type: "expense", currency: "ILS", isPlaceholder: true, updatedAt: NOW },
]);

describe("ancestorsOf", () => {
  it("yields ancestors nearest-first, excluding the starting account", () => {
    expect([...ancestorsOf(linear, "leaf")].map((a) => a.id)).toEqual(["mid", "root"]);
  });

  it("yields nothing for a root account", () => {
    expect([...ancestorsOf(linear, "root")]).toEqual([]);
  });

  it("yields nothing for an unknown account", () => {
    expect([...ancestorsOf(linear, "missing")]).toEqual([]);
  });

  it("stops instead of looping forever on a parent cycle", () => {
    expect([...ancestorsOf(cyclic, "leaf")].map((a) => a.id)).toEqual(["A", "B"]);
  });
});

describe("periodBreakdown on a cyclic book", () => {
  it("terminates instead of hanging in the ancestors walk", () => {
    const result = periodBreakdown(cyclic, { from: "2026-08-01", to: "2026-08-31" }, "leaf");
    expect(result.ok).toBe(true);
  });
});
