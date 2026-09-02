import { createAccount, deleteAccount, updateAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { removeBudget, setBudget } from "../../src/kernel/budgets";
import { mergeBooks } from "../../src/kernel/merge";
import { validateBook } from "../../src/kernel/validate";
import type { Book } from "../../src/kernel/types";
import { unwrap, unwrapErr } from "../helpers";

const T = (m: number) => `2026-09-02T10:${String(m).padStart(2, "0")}:00.000Z`;

/** Base: Cash (asset leaf), Food (expense leaf), Groups (expense placeholder). */
function base(): { book: Book; cashId: string; foodId: string; groupId: string } {
  let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, T(0)));
  book = unwrap(createAccount(book, { parentId: null, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false }, T(0)));
  book = unwrap(createAccount(book, { parentId: null, name: "Food", type: "expense", currency: "ILS", isPlaceholder: false }, T(0)));
  book = unwrap(createAccount(book, { parentId: null, name: "Groups", type: "expense", currency: "ILS", isPlaceholder: true }, T(0)));
  return { book, cashId: book.accounts[0].id, foodId: book.accounts[1].id, groupId: book.accounts[2].id };
}

function spend(book: Book, cashId: string, foodId: string, amount: number, at: string): Book {
  return unwrap(
    postEntry(book, {
      date: "2026-01-10",
      description: "x",
      postings: [
        { accountId: foodId, side: "debit", amount },
        { accountId: cashId, side: "credit", amount },
      ],
    }, at),
  );
}

function mergedBothOrders(a: Book, b: Book): Book {
  const ab = unwrap(mergeBooks(a, b));
  const ba = unwrap(mergeBooks(b, a));
  expect(ab).toEqual(ba);
  expect(validateBook(ab).ok).toBe(true);
  return ab;
}

describe("mergeBooks record LWW", () => {
  it("is idempotent: merging a book with itself returns that book, sorted", () => {
    const { book } = base();
    const sorted: Book = {
      ...book,
      accounts: [...book.accounts].sort((x, y) => (x.id < y.id ? -1 : 1)),
    };
    const once = unwrap(mergeBooks(book, book));
    expect(once).toEqual(sorted);
    expect(unwrap(mergeBooks(once, once))).toEqual(once);
  });

  it("keeps the later rename, symmetrically", () => {
    const { book, cashId } = base();
    const a = unwrap(updateAccount(book, { id: cashId, name: "Wallet" }, T(1)));
    const b = unwrap(updateAccount(book, { id: cashId, name: "Purse" }, T(2)));
    const merged = mergedBothOrders(a, b);
    expect(merged.accounts.find((x) => x.id === cashId)?.name).toBe("Purse");
  });

  it("unions entries created on both sides", () => {
    const { book, cashId, foodId } = base();
    const a = spend(book, cashId, foodId, 100, T(1));
    const b = spend(book, cashId, foodId, 200, T(2));
    const merged = mergedBothOrders(a, b);
    expect(merged.journal).toHaveLength(2);
  });

  it("delete loses to a later edit (resurrection) and beats an earlier one", () => {
    const { book, foodId } = base();
    const deletedAt2 = unwrap(deleteAccount(book, foodId, T(2)));
    const renamedAt3 = unwrap(updateAccount(book, { id: foodId, name: "Meals" }, T(3)));
    const resurrected = mergedBothOrders(deletedAt2, renamedAt3);
    expect(resurrected.accounts.find((x) => x.id === foodId)?.name).toBe("Meals");
    expect(resurrected.tombstones).toHaveLength(0);

    const renamedAt1 = unwrap(updateAccount(book, { id: foodId, name: "Meals" }, T(1)));
    const stillDead = mergedBothOrders(deletedAt2, renamedAt1);
    expect(stillDead.accounts.some((x) => x.id === foodId)).toBe(false);
    expect(stillDead.tombstones.some((t) => t.kind === "account" && t.key === foodId)).toBe(true);
  });

  it("merges budgets by natural key with tombstones", () => {
    const { book, foodId } = base();
    const key = { accountId: foodId, period: "month" as const, currency: "ILS" };
    const a = unwrap(setBudget(book, { ...key, limit: 100 }, T(1)));
    const b = unwrap(removeBudget(unwrap(setBudget(book, { ...key, limit: 100 }, T(1))), key, T(2)));
    const merged = mergedBothOrders(a, b);
    expect(merged.budgets).toHaveLength(0);
  });

  it("meta: later metaUpdatedAt wins", () => {
    const { book } = base();
    const other: Book = { ...structuredClone(book), name: "Renamed", metaUpdatedAt: T(5) };
    const merged = mergedBothOrders(book, other);
    expect(merged.name).toBe("Renamed");
    expect(merged.metaUpdatedAt).toBe(T(5));
  });
});

describe("mergeBooks repair ladder", () => {
  it("restores a deleted account that the other side posted to", () => {
    const { book, cashId, foodId } = base();
    const a = unwrap(deleteAccount(book, foodId, T(1)));
    const b = spend(book, cashId, foodId, 100, T(2));
    const merged = mergedBothOrders(a, b);
    expect(merged.accounts.some((x) => x.id === foodId)).toBe(true);
    expect(merged.journal).toHaveLength(1);
  });

  it("re-flags a parent as placeholder when the other side gave it a child", () => {
    const { book, groupId } = base();
    // A: group loses placeholder (valid: no children, no postings on A)
    const a = unwrap(updateAccount(book, { id: groupId, isPlaceholder: false }, T(2)));
    // B: a child appears under the group
    const b = unwrap(createAccount(book, { parentId: groupId, name: "Cafes", type: "expense", currency: "ILS", isPlaceholder: false }, T(1)));
    const merged = mergedBothOrders(a, b);
    expect(merged.accounts.find((x) => x.id === groupId)?.isPlaceholder).toBe(true);
  });

  it("cascades the parent's type onto a concurrent child", () => {
    const { book, groupId } = base();
    // A: retype the childless placeholder group expense -> income
    const a = unwrap(updateAccount(book, { id: groupId, type: "income" }, T(2)));
    // B: add an expense child under it
    const b = unwrap(createAccount(book, { parentId: groupId, name: "Cafes", type: "expense", currency: "ILS", isPlaceholder: false }, T(1)));
    const merged = mergedBothOrders(a, b);
    const child = merged.accounts.find((x) => x.name === "Cafes");
    expect(child?.type).toBe("income");
  });

  it("renames duplicate siblings deterministically (the doubled-onboarding case)", () => {
    const { book } = base();
    const a = unwrap(createAccount(book, { parentId: null, name: "Assets", type: "asset", currency: "ILS", isPlaceholder: true }, T(1)));
    const b = unwrap(createAccount(book, { parentId: null, name: "Assets", type: "asset", currency: "ILS", isPlaceholder: true }, T(2)));
    const merged = mergedBothOrders(a, b);
    const names = merged.accounts.filter((x) => x.name.startsWith("Assets")).map((x) => x.name).sort();
    expect(names).toEqual(["Assets", "Assets 2"]);
  });

  it("drops a budget whose account got retyped away from expense", () => {
    const { book, groupId } = base();
    const leafed = unwrap(createAccount(book, { parentId: groupId, name: "Cafes", type: "expense", currency: "ILS", isPlaceholder: false }, T(0)));
    const cafesId = leafed.accounts.find((x) => x.name === "Cafes")!.id;
    const a = unwrap(setBudget(leafed, { accountId: cafesId, period: "month", currency: "ILS", limit: 100 }, T(1)));
    // B: retype the whole group (childless? no - Cafes exists on B too, so retype the LEAF instead)
    const b = unwrap(updateAccount(leafed, { id: cafesId, type: "income", parentId: null }, T(2)));
    const merged = mergedBothOrders(a, b);
    expect(merged.budgets).toHaveLength(0);
  });

  it("breaks a parent cycle by detaching its lowest-id member", () => {
    const { book, groupId } = base();
    const two = unwrap(createAccount(book, { parentId: null, name: "Other", type: "expense", currency: "ILS", isPlaceholder: true }, T(0)));
    const otherId = two.accounts.find((x) => x.name === "Other")!.id;
    // Each move is legal locally: wouldCreateCycle only ever sees one device's book.
    const a = unwrap(updateAccount(two, { id: groupId, parentId: otherId }, T(1)));
    const b = unwrap(updateAccount(two, { id: otherId, parentId: groupId }, T(1)));
    const merged = mergedBothOrders(a, b);
    const [low, high] = groupId < otherId ? [groupId, otherId] : [otherId, groupId];
    expect(merged.accounts.find((x) => x.id === low)?.parentId).toBe(null);
    expect(merged.accounts.find((x) => x.id === high)?.parentId).toBe(low);
  });

  it("cascades the type onto accounts freed from a cycle", () => {
    const { book, groupId } = base();
    const two = unwrap(createAccount(book, { parentId: null, name: "Other", type: "expense", currency: "ILS", isPlaceholder: true }, T(0)));
    const otherId = two.accounts.find((x) => x.name === "Other")!.id;
    // A retypes both to income while they are still childless roots, then parents
    // Groups under Other. B only parents Other under Groups, keeping them expense.
    // Each account's winner brings its own type, so the merged cycle is mistyped.
    let a = unwrap(updateAccount(two, { id: groupId, type: "income" }, T(1)));
    a = unwrap(updateAccount(a, { id: otherId, type: "income" }, T(1)));
    a = unwrap(updateAccount(a, { id: groupId, parentId: otherId }, T(2)));
    const b = unwrap(updateAccount(two, { id: otherId, parentId: groupId }, T(3)));
    const merged = mergedBothOrders(a, b);
    const [low, high] = groupId < otherId ? [groupId, otherId] : [otherId, groupId];
    const detached = merged.accounts.find((x) => x.id === low);
    const freed = merged.accounts.find((x) => x.id === high);
    expect(detached?.parentId).toBe(null);
    expect(freed?.parentId).toBe(low);
    // The cascade only reaches `high` because the cycle was broken before it ran.
    expect(freed?.type).toBe(detached?.type);
  });

  it("refuses a currency change under an entry the other device posted", () => {
    const { book, cashId, foodId } = base();
    // A: Food carries no postings here, so changing its currency is legal.
    const a = unwrap(updateAccount(book, { id: foodId, currency: "USD" }, T(1)));
    // B: spends 100 ILS through Food. Union would silently read that 100 as USD.
    const b = spend(book, cashId, foodId, 100, T(2));
    expect(unwrapErr(mergeBooks(a, b)).code).toBe("SYNC_MERGE_CONFLICT");
    expect(unwrapErr(mergeBooks(b, a)).code).toBe("SYNC_MERGE_CONFLICT");
  });

  it("refuses a currency change that invalidates a concurrent fx entry", () => {
    const { book, foodId } = base();
    const withUsd = unwrap(createAccount(book, { parentId: null, name: "CashUSD", type: "asset", currency: "USD", isPlaceholder: false }, T(0)));
    const usdId = withUsd.accounts.find((x) => x.name === "CashUSD")!.id;
    const a = unwrap(updateAccount(withUsd, { id: foodId, currency: "EUR" }, T(1)));
    const b = unwrap(
      postEntry(withUsd, {
        date: "2026-01-10",
        description: "x",
        postings: [
          { accountId: foodId, side: "debit", amount: 370 },
          { accountId: usdId, side: "credit", amount: 100 },
        ],
        fx: { baseCurrency: "ILS", quoteCurrency: "USD", baseAmount: 370, quoteAmount: 100 },
      }, T(2)),
    );
    expect(unwrapErr(mergeBooks(a, b)).code).toBe("SYNC_MERGE_CONFLICT");
    expect(unwrapErr(mergeBooks(b, a)).code).toBe("SYNC_MERGE_CONFLICT");
  });

  it("allows a currency change on an account no entry touches", () => {
    const { book, cashId, foodId } = base();
    const spare = unwrap(createAccount(book, { parentId: null, name: "Spare", type: "asset", currency: "ILS", isPlaceholder: false }, T(0)));
    const spareId = spare.accounts.find((x) => x.name === "Spare")!.id;
    const a = unwrap(updateAccount(spare, { id: spareId, currency: "USD" }, T(1)));
    const b = spend(spare, cashId, foodId, 100, T(2));
    const merged = mergedBothOrders(a, b);
    expect(merged.accounts.find((x) => x.id === spareId)?.currency).toBe("USD");
    expect(merged.journal).toHaveLength(1);
  });

  it("returns SYNC_MERGE_CONFLICT when an account has both children and postings, in both orders", () => {
    const { book, cashId, groupId } = base();
    // A: post to the group after un-flagging it
    const aFlat = unwrap(updateAccount(book, { id: groupId, isPlaceholder: false }, T(1)));
    const a = unwrap(
      postEntry(aFlat, {
        date: "2026-01-10",
        description: "x",
        postings: [
          { accountId: groupId, side: "debit", amount: 100 },
          { accountId: cashId, side: "credit", amount: 100 },
        ],
      }, T(2)),
    );
    // B: give the group a child
    const b = unwrap(createAccount(book, { parentId: groupId, name: "Cafes", type: "expense", currency: "ILS", isPlaceholder: false }, T(3)));
    expect(unwrapErr(mergeBooks(a, b)).code).toBe("SYNC_MERGE_CONFLICT");
    expect(unwrapErr(mergeBooks(b, a)).code).toBe("SYNC_MERGE_CONFLICT");
  });
});
