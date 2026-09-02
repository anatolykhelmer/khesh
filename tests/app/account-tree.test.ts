import { describe, expect, it } from "vitest";
import type { AccountNode } from "../../src/kernel";
import { expandedForSelection, pathOf, visibleRows } from "../../src/app/account-tree";
import { NOW } from "../helpers";

function group(id: string, name: string, children: AccountNode[]): AccountNode {
  return {
    id,
    parentId: null,
    name,
    type: "expense",
    currency: "ILS",
    isPlaceholder: true,
    updatedAt: NOW,
    children,
  };
}

function leaf(id: string, name: string, currency = "ILS"): AccountNode {
  return {
    id,
    parentId: null,
    name,
    type: "expense",
    currency,
    isPlaceholder: false,
    updatedAt: NOW,
    children: [],
  };
}

// Expenses > Food > {Groceries, Cafes}, Expenses > Rent, Assets > Cash
const TREE: AccountNode[] = [
  group("expenses", "Expenses", [
    group("food", "Food", [leaf("groceries", "Groceries"), leaf("cafes", "Cafes")]),
    leaf("rent", "Rent"),
  ]),
  group("assets", "Assets", [leaf("cash", "Cash", "USD")]),
];

const browse = (expanded: string[] = [], groupsSelectable = true) =>
  visibleRows(TREE, { query: "", expanded: new Set(expanded), groupsSelectable });

describe("visibleRows, browsing", () => {
  it("shows only roots when nothing is expanded", () => {
    expect(browse().map((row) => row.id)).toEqual(["expenses", "assets"]);
  });

  it("reveals the children of an expanded group but not its grandchildren", () => {
    expect(browse(["expenses"]).map((row) => row.id)).toEqual([
      "expenses",
      "food",
      "rent",
      "assets",
    ]);
  });

  it("reveals grandchildren once the whole chain is expanded", () => {
    expect(browse(["expenses", "food"]).map((row) => row.id)).toEqual([
      "expenses",
      "food",
      "groceries",
      "cafes",
      "rent",
      "assets",
    ]);
  });

  it("hides children of a collapsed group even when the group itself is expanded deeper down", () => {
    // "food" is in the set but its parent is not, so nothing under Expenses shows.
    expect(browse(["food"]).map((row) => row.id)).toEqual(["expenses", "assets"]);
  });

  it("reports path, depth, children and expansion per row", () => {
    const rows = browse(["expenses", "food"]);
    expect(rows.find((row) => row.id === "groceries")).toEqual({
      id: "groceries",
      name: "Groceries",
      path: "Expenses:Food:Groceries",
      depth: 2,
      hasChildren: false,
      expanded: false,
      isGroup: false,
      selectable: true,
      currency: "ILS",
    });
    expect(rows.find((row) => row.id === "food")).toMatchObject({
      path: "Expenses:Food",
      depth: 1,
      hasChildren: true,
      expanded: true,
      isGroup: true,
    });
    expect(rows.find((row) => row.id === "assets")).toMatchObject({
      hasChildren: true,
      expanded: false,
    });
  });

  it("carries the account's own currency", () => {
    expect(browse(["assets"]).find((row) => row.id === "cash")?.currency).toBe("USD");
  });

  it("marks groups unselectable when groups may not be chosen", () => {
    const rows = visibleRows(TREE, {
      query: "",
      expanded: new Set(["expenses"]),
      groupsSelectable: false,
    });
    expect(rows.find((row) => row.id === "expenses")?.selectable).toBe(false);
    expect(rows.find((row) => row.id === "food")?.selectable).toBe(false);
    expect(rows.find((row) => row.id === "rent")?.selectable).toBe(true);
  });

  it("keeps a childless group unselectable when groups may not be chosen", () => {
    const empty: AccountNode[] = [group("empty", "Empty", [])];
    const [row] = visibleRows(empty, {
      query: "",
      expanded: new Set(),
      groupsSelectable: false,
    });
    expect(row).toMatchObject({ hasChildren: false, isGroup: true, selectable: false });
  });
});

describe("visibleRows, searching", () => {
  const search = (query: string, groupsSelectable = true) =>
    visibleRows(TREE, { query, expanded: new Set(), groupsSelectable });

  it("keeps a matching leaf and its ancestors, dropping unrelated branches", () => {
    expect(search("groceries").map((row) => row.id)).toEqual(["expenses", "food", "groceries"]);
  });

  it("shows the whole subtree of a matching group", () => {
    expect(search("food").map((row) => row.id)).toEqual([
      "expenses",
      "food",
      "groceries",
      "cafes",
    ]);
  });

  it("ignores case", () => {
    expect(search("CASH").map((row) => row.id)).toEqual(["assets", "cash"]);
  });

  it("matches on any segment of the path", () => {
    expect(search("expenses:rent").map((row) => row.id)).toEqual(["expenses", "rent"]);
  });

  it("ignores surrounding whitespace", () => {
    expect(search("  rent  ").map((row) => row.id)).toEqual(["expenses", "rent"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(search("zzz")).toEqual([]);
  });

  it("treats a blank query as browsing", () => {
    expect(search("   ").map((row) => row.id)).toEqual(["expenses", "assets"]);
  });

  it("reports every visible branch as expanded and ignores the expansion set", () => {
    const rows = visibleRows(TREE, {
      query: "cafes",
      expanded: new Set(),
      groupsSelectable: true,
    });
    expect(rows.map((row) => row.id)).toEqual(["expenses", "food", "cafes"]);
    expect(rows.find((row) => row.id === "food")?.expanded).toBe(true);
    expect(rows.find((row) => row.id === "cafes")?.expanded).toBe(false);
  });

  it("keeps depth from the full tree, not from the filtered result", () => {
    expect(search("groceries").map((row) => row.depth)).toEqual([0, 1, 2]);
  });

  it("still marks groups unselectable while searching", () => {
    expect(search("food", false).find((row) => row.id === "food")?.selectable).toBe(false);
  });
});

describe("expandedForSelection", () => {
  it("returns the ancestors of the selection without the selection itself", () => {
    expect([...expandedForSelection(TREE, "groceries")].sort()).toEqual(["expenses", "food"]);
  });

  it("returns nothing for a root", () => {
    expect([...expandedForSelection(TREE, "expenses")]).toEqual([]);
  });

  it("returns nothing for no selection", () => {
    expect([...expandedForSelection(TREE, null)]).toEqual([]);
  });

  it("returns nothing for an id the tree does not hold", () => {
    expect([...expandedForSelection(TREE, "gone")]).toEqual([]);
  });

  it("returns only the ancestors of a selected group with children, excluding the group itself", () => {
    expect([...expandedForSelection(TREE, "food")].sort()).toEqual(["expenses"]);
  });
});

describe("pathOf", () => {
  it("resolves a nested id to its full path", () => {
    expect(pathOf(TREE, "groceries")).toBe("Expenses:Food:Groceries");
  });

  it("resolves a root id to its name", () => {
    expect(pathOf(TREE, "assets")).toBe("Assets");
  });

  it("returns null for no id and for an unknown id", () => {
    expect(pathOf(TREE, null)).toBeNull();
    expect(pathOf(TREE, "gone")).toBeNull();
  });

  it("distinguishes two same-named leaves living under different branches", () => {
    const tree: AccountNode[] = [
      group("expenses", "Expenses", [group("food", "Food", [leaf("cash-a", "Cash")])]),
      group("assets", "Assets", [leaf("cash-b", "Cash")]),
    ];
    expect(pathOf(tree, "cash-a")).toBe("Expenses:Food:Cash");
    expect(pathOf(tree, "cash-b")).toBe("Assets:Cash");

    const rows = visibleRows(tree, {
      query: "",
      expanded: new Set(["expenses", "food", "assets"]),
      groupsSelectable: true,
    });
    expect(rows.map((row) => ({ id: row.id, path: row.path }))).toEqual([
      { id: "expenses", path: "Expenses" },
      { id: "food", path: "Expenses:Food" },
      { id: "cash-a", path: "Expenses:Food:Cash" },
      { id: "assets", path: "Assets" },
      { id: "cash-b", path: "Assets:Cash" },
    ]);
  });
});
