import { describe, expect, it } from "vitest";
import { descendants } from "../../src/kernel/book-utils";
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

const tree = makeBook([
  { id: "root", parentId: null, name: "Expenses", type: "expense", currency: "ILS", isPlaceholder: true, updatedAt: NOW },
  { id: "food", parentId: "root", name: "Food", type: "expense", currency: "ILS", isPlaceholder: true, updatedAt: NOW },
  { id: "cafes", parentId: "food", name: "Cafes", type: "expense", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
  { id: "rent", parentId: "root", name: "Rent", type: "expense", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
]);

describe("descendants", () => {
  it("returns the whole subtree depth-first", () => {
    expect(descendants(tree, "root").map((a) => a.id)).toEqual(["food", "cafes", "rent"]);
  });

  it("returns nothing for a leaf", () => {
    expect(descendants(tree, "cafes")).toEqual([]);
  });

  it("stops instead of recursing forever on a parent cycle", () => {
    const cyclic = makeBook([
      { id: "A", parentId: "B", name: "A", type: "expense", currency: "ILS", isPlaceholder: true, updatedAt: NOW },
      { id: "B", parentId: "A", name: "B", type: "expense", currency: "ILS", isPlaceholder: true, updatedAt: NOW },
    ]);
    expect(descendants(cyclic, "A").map((a) => a.id)).toEqual(["B"]);
  });
});
