import { describe, expect, it } from "vitest";
import { createAccount } from "../../src/kernel/accounts";
import { postEntry } from "../../src/kernel/journal";
import { bookFingerprint, mergeBooks } from "../../src/kernel/merge";
import { validateBook } from "../../src/kernel/validate";
import type { Book } from "../../src/kernel/types";
import { unwrap } from "../helpers";
import { realBook, ROOT, type RootIds } from "../helpers/book";

const T = (m: number) => `2026-09-02T10:${String(m).padStart(2, "0")}:00.000Z`;

/** A second device's roots: the same four names at its own ids, as two runs of
 * `createHousehold` produced before this change. */
const B: RootIds = { asset: "b:asset", liability: "b:liability", income: "b:income", expense: "b:expense" };

/** The four roots at seed ids, as `createHousehold` mints them after Task 2. */
const SEED: RootIds = { asset: "seed:assets", liability: "seed:liabilities", income: "seed:income", expense: "seed:expenses" };

function mergedBothOrders(a: Book, b: Book): Book {
  const ab = unwrap(mergeBooks(a, b));
  const ba = unwrap(mergeBooks(b, a));
  expect(ab).toEqual(ba);
  expect(validateBook(ab).ok).toBe(true);
  return ab;
}

/** One device's book: the four roots at `ids`, with one expense leaf under its own root. */
function device(ids: RootIds, leafId: string, leafName: string, at: string): Book {
  return unwrap(
    createAccount(
      realBook("ILS", at, ids),
      { id: leafId, parentId: ids.expense, name: leafName, type: "expense", currency: "ILS", isPlaceholder: false },
      at,
    ),
  );
}

describe("mergeBooks root collapse", () => {
  it("collapses the roots of two separately onboarded books, keeping both sets of leaves", () => {
    const a = device(ROOT, "a:leaf", "Groceries", T(1));
    const b = device(B, "b:leaf", "Rent", T(2));
    const merged = mergedBothOrders(a, b);
    const roots = merged.accounts.filter((x) => x.parentId === null);
    expect(roots).toHaveLength(4);
    const expenseRoot = roots.find((x) => x.type === "expense")!;
    expect(
      merged.accounts.filter((x) => x.parentId === expenseRoot.id).map((x) => x.name).sort(),
    ).toEqual(["Groceries", "Rent"]);
    expect(merged.accounts.filter((x) => / \d+$/.test(x.name))).toEqual([]);
  });

  it("collapses them even when the two sides named the roots differently", () => {
    // The language case: nothing on screen said these were the same account twice, because
    // the dedup rung keys on names and these do not clash.
    const a = device(ROOT, "a:leaf", "Groceries", T(1));
    const b = device(B, "b:leaf", "Rent", T(2));
    b.accounts = b.accounts.map((x) => (x.parentId === null ? { ...x, name: `${x.name} (he)` } : x));
    const merged = mergedBothOrders(a, b);
    expect(merged.accounts.filter((x) => x.parentId === null)).toHaveLength(4);
  });

  it("prefers the seed id, so a pre-seed book converges on it", () => {
    const a = device(ROOT, "a:leaf", "Groceries", T(9));
    const b = device(SEED, "b:leaf", "Rent", T(1));
    const merged = mergedBothOrders(a, b);
    const roots = merged.accounts.filter((x) => x.parentId === null).map((x) => x.id).sort();
    expect(roots).toEqual(["seed:assets", "seed:expenses", "seed:income", "seed:liabilities"]);
  });

  it("leaves a tombstone for each dropped root, so none of them comes back", () => {
    const a = device(ROOT, "a:leaf", "Groceries", T(1));
    const b = device(B, "b:leaf", "Rent", T(2));
    const merged = mergedBothOrders(a, b);
    expect(merged.tombstones.map((t) => t.kind)).toEqual(["account", "account", "account", "account"]);
    expect(unwrap(mergeBooks(merged, a))).toEqual(merged);
    expect(unwrap(mergeBooks(merged, b))).toEqual(merged);
    expect(bookFingerprint(unwrap(mergeBooks(merged, a)))).toBe(bookFingerprint(merged));
  });

  it("hands colliding children to the dedup rung rather than producing an invalid book", () => {
    const a = device(ROOT, "a:leaf", "Groceries", T(1));
    const b = device(B, "b:leaf", "Groceries", T(2));
    const merged = mergedBothOrders(a, b);
    expect(
      merged.accounts.filter((x) => x.parentId !== null).map((x) => x.name).sort(),
    ).toEqual(["Groceries", "Groceries 2"]);
  });

  it("leaves the opening-balances system root alone beside another equity root", () => {
    let a = realBook("ILS", T(1));
    a = unwrap(createAccount(a, { id: "sys:ob", parentId: null, name: "Opening Balances", type: "equity", currency: "ILS", isPlaceholder: true }, T(1)));
    a = unwrap(createAccount(a, { id: "equity:reserves", parentId: null, name: "Reserves", type: "equity", currency: "ILS", isPlaceholder: true }, T(1)));
    const merged = mergedBothOrders(a, a);
    expect(merged.accounts.filter((x) => x.type === "equity").map((x) => x.id).sort()).toEqual([
      "equity:reserves",
      "sys:ob",
    ]);
  });

  it("keeps a posted-to leaf, and its entry, under the surviving root", () => {
    let a = device(ROOT, "a:leaf", "Groceries", T(1));
    a = unwrap(createAccount(a, { id: "a:cash", parentId: ROOT.asset, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false }, T(1)));
    a = unwrap(
      postEntry(a, {
        date: "2026-01-10",
        description: "x",
        postings: [
          { accountId: "a:leaf", side: "debit", amount: 100 },
          { accountId: "a:cash", side: "credit", amount: 100 },
        ],
      }, T(2)),
    );
    const b = device(B, "b:leaf", "Rent", T(3));
    const merged = mergedBothOrders(a, b);
    const expenseRoot = merged.accounts.find((x) => x.parentId === null && x.type === "expense")!;
    expect(merged.accounts.find((x) => x.id === "a:leaf")?.parentId).toBe(expenseRoot.id);
    expect(merged.journal).toHaveLength(1);
  });
});
