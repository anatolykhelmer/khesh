import { createAccount, deleteAccount, updateAccount } from "../../src/kernel/accounts";
import { postEntry } from "../../src/kernel/journal";
import { removeBudget, setBudget } from "../../src/kernel/budgets";
import { mergeBooks } from "../../src/kernel/merge";
import { budgetKeyOf } from "../../src/kernel/tombstones";
import { validateBook } from "../../src/kernel/validate";
import type { Book } from "../../src/kernel/types";
import { unwrap, unwrapErr } from "../helpers";
import { accountNamed, realBook, ROOT } from "../helpers/book";

const T = (m: number) => `2026-09-02T10:${String(m).padStart(2, "0")}:00.000Z`;

/** Base: the four category roots, with Cash (asset leaf), Food (expense leaf) and Groups
 * (expense placeholder) under them. */
function base(): { book: Book; cashId: string; foodId: string; groupId: string } {
  let book = realBook("ILS", T(0));
  book = unwrap(createAccount(book, { parentId: ROOT.asset, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false }, T(0)));
  book = unwrap(createAccount(book, { parentId: ROOT.expense, name: "Food", type: "expense", currency: "ILS", isPlaceholder: false }, T(0)));
  book = unwrap(createAccount(book, { parentId: ROOT.expense, name: "Groups", type: "expense", currency: "ILS", isPlaceholder: true }, T(0)));
  return {
    book,
    cashId: accountNamed(book, "Cash").id,
    foodId: accountNamed(book, "Food").id,
    groupId: accountNamed(book, "Groups").id,
  };
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

/** A book with `Cash` under Assets, `Nest` under Expenses, and `ids` as placeholder groups
 * inside `Nest` — the shape a parent cycle needs: real categories, nested, at ids the
 * fixture can name. `Cash` is the counter-account for `spend`, so a test that posts does
 * not have to borrow a second book's accounts. */
function nested(ids: readonly string[]): Book {
  let book = unwrap(createAccount(realBook("ILS", T(0)), { id: "cash", parentId: ROOT.asset, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false }, T(0)));
  book = unwrap(createAccount(book, { id: "nest", parentId: ROOT.expense, name: "Nest", type: "expense", currency: "ILS", isPlaceholder: true }, T(0)));
  for (const id of ids) {
    book = unwrap(createAccount(book, { id, parentId: "nest", name: id.toUpperCase(), type: "expense", currency: "ILS", isPlaceholder: true }, T(0)));
  }
  return book;
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

  it("restores the newest live version, not the deleting device's snapshot", () => {
    // A edits Food and keeps it; B deletes it later, so the tombstone wins the race —
    // but B also posted to it, so rung 1 has to bring it back. Restoring the snapshot
    // the tombstone carries would drop A's rename, and the merge would not settle:
    // re-merging A (which still holds the rename) would produce a different book again.
    const { book, cashId, foodId } = base();
    const renamed = unwrap(updateAccount(book, { id: foodId, name: "Meals" }, T(1)));
    const a = spend(renamed, cashId, foodId, 100, T(1));
    const b = unwrap(deleteAccount(book, foodId, T(2)));
    const merged = mergedBothOrders(a, b);
    expect(merged.accounts.find((x) => x.id === foodId)?.name).toBe("Meals");
    expect(merged.tombstones).toHaveLength(0);
    expect(unwrap(mergeBooks(merged, a))).toEqual(merged);
    expect(unwrap(mergeBooks(merged, b))).toEqual(merged);
  });

  it("restores the deleting device's snapshot when that is the newest version anywhere", () => {
    // The mirror of the case above, and the one a symmetric-and-convergent property
    // cannot see: A renames Food to "Meals" and only then deletes it, so the tombstone
    // it leaves carries the newest version of the record in existence. B never saw the
    // rename and posts through the still-named "Food", so the live copy the union can
    // reach is the older one. The delete wins the record race and the posting forces
    // rung 1 to bring the account back — taking the live copy on sight would silently
    // undo a rename the tombstone itself was holding.
    const { book, cashId, foodId } = base();
    const renamed = unwrap(updateAccount(book, { id: foodId, name: "Meals" }, T(2)));
    const a = unwrap(deleteAccount(renamed, foodId, T(3)));
    const b = spend(book, cashId, foodId, 100, T(1));
    const merged = mergedBothOrders(a, b);
    expect(merged.accounts.find((x) => x.id === foodId)?.name).toBe("Meals");
    expect(merged.tombstones).toHaveLength(0);
    expect(merged.journal).toHaveLength(1);
    expect(unwrap(mergeBooks(merged, a))).toEqual(merged);
    expect(unwrap(mergeBooks(merged, b))).toEqual(merged);
  });

  it("keeps a resurrected account alive once a later rung drops what referenced it", () => {
    // B budgets Food and then retypes it; A deletes it. The delete is later, so the
    // union kills Food — but B's budget still points at it, so rung 1 brings it back,
    // and rung 6 then drops that budget because Food is no longer an expense. The
    // reference the restore rested on is gone, so nothing would bring Food back a
    // second time: the restored record has to outrank the tombstone by itself, or
    // re-merging A deletes Food again and the two devices never settle. Rung 2 does
    // the same thing when it detaches a cycle member that was the restored account's
    // only parent link — the property suite covers that shape.
    const { book, foodId } = base();
    const budgeted = unwrap(
      setBudget(book, { accountId: foodId, period: "month", currency: "ILS", limit: 100 }, T(1)),
    );
    // The retype-and-move is written directly rather than through `updateAccount`, which
    // refuses it (ACCOUNT_HAS_BUDGETS) precisely so this state cannot be created locally.
    // The state still reaches a merge — from a client built before that guard, or from an
    // imported snapshot — and handling it is what this test is about.
    const b: Book = {
      ...budgeted,
      accounts: budgeted.accounts.map((x) =>
        x.id === foodId ? { ...x, type: "income" as const, parentId: ROOT.income, updatedAt: T(2) } : x,
      ),
    };
    const a = unwrap(deleteAccount(book, foodId, T(3)));
    const merged = mergedBothOrders(a, b);
    expect(merged.accounts.find((x) => x.id === foodId)?.type).toBe("income");
    expect(merged.budgets).toHaveLength(0);
    // Food's own tombstone is gone — the restore consumed it — and the only one left is
    // the limit's, written by the rung that dropped it.
    expect(merged.tombstones.map((t) => t.kind)).toEqual(["budget"]);
    expect(unwrap(mergeBooks(merged, a))).toEqual(merged);
    expect(unwrap(mergeBooks(merged, b))).toEqual(merged);
  });

  it("a repaired record outranks the un-repaired copy the other device still holds", () => {
    // Both devices hold "Daily" with the same stamp under different parents, so the
    // union settles it on canonical order: the pristine device's parent wins because
    // its id sorts higher. That puts "Daily" next to the second "Daily" the other
    // device created, and the dedup rung renames one of them. The rename must outlive
    // the next sync: it changes `name`, which sorts ahead of `parentId`, so an
    // unstamped repair loses the very tie it came from — the parent flips back, the
    // clash dissolves and the rename is undone.
    // G1 and G2 are groups under Expenses: a contested parent is the subject, and two
    // top-level groups of one type are not a shape a real book has.
    let book = realBook("ILS", T(0));
    book = unwrap(createAccount(book, { parentId: ROOT.expense, name: "G1", type: "expense", currency: "ILS", isPlaceholder: true }, T(0)));
    book = unwrap(createAccount(book, { parentId: ROOT.expense, name: "G2", type: "expense", currency: "ILS", isPlaceholder: true }, T(0)));
    const [lo, hi] = [accountNamed(book, "G1").id, accountNamed(book, "G2").id].sort();
    book = unwrap(createAccount(book, { parentId: hi, name: "Daily", type: "expense", currency: "ILS", isPlaceholder: false }, T(0)));
    const dailyId = accountNamed(book, "Daily").id;

    const a = book;
    // Same stamp as the creation: two devices, one clock tick.
    const moved = unwrap(updateAccount(book, { id: dailyId, parentId: lo }, T(0)));
    // USD sorts above ILS and `currency` is the first key canonical order compares,
    // so this newcomer is the one that keeps the name and the contested record is the
    // one the dedup rung rewrites.
    const b = unwrap(createAccount(moved, { parentId: hi, name: "Daily", type: "expense", currency: "USD", isPlaceholder: false }, T(0)));

    const merged = mergedBothOrders(a, b);
    const contested = merged.accounts.find((x) => x.id === dailyId);
    expect(contested?.parentId).toBe(hi);
    expect(contested?.name).toBe("Daily 2");
    expect(unwrap(mergeBooks(merged, a))).toEqual(merged);
    expect(unwrap(mergeBooks(merged, b))).toEqual(merged);
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
    // A: retype the childless placeholder group expense -> income — a real move under
    // Income, since a retype is a move.
    const a = unwrap(updateAccount(book, { id: groupId, type: "income", parentId: ROOT.income }, T(2)));
    // B: add an expense child under it
    const b = unwrap(createAccount(book, { parentId: groupId, name: "Cafes", type: "expense", currency: "ILS", isPlaceholder: false }, T(1)));
    const merged = mergedBothOrders(a, b);
    const child = merged.accounts.find((x) => x.name === "Cafes");
    expect(child?.type).toBe("income");
  });

  it("renames duplicate siblings deterministically (the doubled-onboarding case)", () => {
    // Two devices onboarded separately: the same four root names at different ids.
    const a = realBook("ILS", T(1));
    const b = realBook("ILS", T(2), { asset: "b:asset", liability: "b:liability", income: "b:income", expense: "b:expense" });
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
    const b = unwrap(updateAccount(leafed, { id: cafesId, type: "income", parentId: ROOT.income }, T(2)));
    const merged = mergedBothOrders(a, b);
    expect(merged.budgets).toHaveLength(0);
  });

  it("leaves a tombstone for the budget it drops, so the delete stops coming back", () => {
    // B removes the limit and retypes Food in the same instant; A still holds the limit.
    // `later` hands a live/dead tie to the data, so B's tombstone loses — and rung 6 then
    // drops the very record that beat it, because Food is no longer an expense. Writing
    // nothing would leave the merged book with no claim at all on that key: re-merging B
    // would adopt B's tombstone outright, so a merge that should be a no-op would hand
    // the sync engine a changed fingerprint every round.
    const { book, foodId } = base();
    const key = { accountId: foodId, period: "month" as const, currency: "ILS" };
    const a = unwrap(setBudget(book, { ...key, limit: 100 }, T(1)));
    const b = unwrap(
      updateAccount(unwrap(removeBudget(a, key, T(1))), { id: foodId, type: "income", parentId: ROOT.income }, T(1)),
    );
    const merged = mergedBothOrders(a, b);
    expect(merged.budgets).toHaveLength(0);
    expect(merged.tombstones.map((t) => `${t.kind}|${t.key}`)).toEqual([
      `budget|${budgetKeyOf(key)}`,
    ]);
    // One millisecond past the record it dropped, so it outranks the copy A still holds
    // rather than tying with it, and it comes from the record instead of a clock.
    expect(merged.tombstones[0].deletedAt).toBe("2026-09-02T10:01:00.001Z");
    expect(unwrap(mergeBooks(merged, a))).toEqual(merged);
    expect(unwrap(mergeBooks(merged, b))).toEqual(merged);
  });

  it("breaks a parent cycle and hands the cut-loose member back its parent from outside it", () => {
    const seeded = nested(["cyc:a", "cyc:b"]);
    // Each move is legal locally: wouldCreateCycle only ever sees one device's book.
    const a = unwrap(updateAccount(seeded, { id: "cyc:a", parentId: "cyc:b" }, T(1)));
    const b = unwrap(updateAccount(seeded, { id: "cyc:b", parentId: "cyc:a" }, T(1)));
    const merged = mergedBothOrders(a, b);
    // `cyc:a` is the lowest id, so it is the one cut loose. B still holds it under Nest,
    // and that copy is the newest one that points outside the cycle, so back it goes.
    expect(merged.accounts.find((x) => x.id === "cyc:a")?.parentId).toBe("nest");
    expect(merged.accounts.find((x) => x.id === "cyc:b")?.parentId).toBe("cyc:a");
  });

  it("sends a member whose every copy points into the cycle to the root of its type", () => {
    const seeded = nested(["cyc:a", "cyc:b", "cyc:c"]);
    // Both devices moved `cyc:a` under `cyc:b`, so no copy of it remembers a parent outside
    // the cycle; the two different third edges are what close the ring.
    let a = unwrap(updateAccount(seeded, { id: "cyc:a", parentId: "cyc:b" }, T(1)));
    a = unwrap(updateAccount(a, { id: "cyc:b", parentId: "cyc:c" }, T(2)));
    let b = unwrap(updateAccount(seeded, { id: "cyc:a", parentId: "cyc:b" }, T(1)));
    b = unwrap(updateAccount(b, { id: "cyc:c", parentId: "cyc:a" }, T(2)));
    const merged = mergedBothOrders(a, b);
    // Not `nest`: nothing in the inputs says it belongs there any more.
    expect(merged.accounts.find((x) => x.id === "cyc:a")?.parentId).toBe(ROOT.expense);
  });

  it("breaks a cycle around the posting-holder instead of refusing, in both id orders", () => {
    // The two repair rungs overlap here: a cycle whose members are one posted-to account
    // and one plain group. Detaching a member clears its parent but leaves the other member
    // pointing at it, so cutting loose the posted-to one hands rung 3 a children-and-postings
    // pair and the whole merge refuses. Which one is cut must therefore not depend on how the
    // ids fall, so both arrangements are exercised.
    const runWith = (poster: string) => {
      const free = poster === "cyc:a" ? "cyc:b" : "cyc:a";
      const seeded = nested(["cyc:a", "cyc:b"]);
      // A: the poster becomes a postable leaf, takes an entry, and moves under `free`.
      let a = unwrap(updateAccount(seeded, { id: poster, isPlaceholder: false }, T(1)));
      a = spend(a, "cash", poster, 100, T(2));
      a = unwrap(updateAccount(a, { id: poster, parentId: free }, T(3)));
      // B: `free` moves under the poster, which is still a placeholder over here.
      const b = unwrap(updateAccount(seeded, { id: free, parentId: poster }, T(3)));

      const merged = mergedBothOrders(a, b);
      expect(merged.accounts.find((x) => x.id === free)?.parentId).toBe("nest");
      expect(merged.accounts.find((x) => x.id === poster)?.parentId).toBe(free);
      expect(merged.journal).toHaveLength(1);
      expect(unwrap(mergeBooks(merged, a))).toEqual(merged);
      expect(unwrap(mergeBooks(merged, b))).toEqual(merged);
    };

    runWith("cyc:a");
    runWith("cyc:b");
  });

  it("repairs, instead of refusing, when a cut-loose group was posted to on a device that had not synced", () => {
    // This is BL-080's `rootWithPostings` case, and this task is what closes it. Rung 2 used
    // to park the cut-loose member at the top level; a device that had not seen that merge
    // could move its child away, turn the member into a leaf and spend through it, and the
    // next merge met a top-level account with postings — which rung 3 could only refuse,
    // because there was no parent to give it. Now there is one.
    // Real-time order throughout: no device's clock runs ahead of another's.
    const seeded = nested(["cyc:a", "cyc:b"]);
    const a1 = unwrap(updateAccount(seeded, { id: "cyc:b", parentId: "cyc:a" }, T(1)));
    const b1 = unwrap(updateAccount(seeded, { id: "cyc:a", parentId: "cyc:b" }, T(4)));
    const repairedBook = mergedBothOrders(a1, b1);
    expect(repairedBook.accounts.find((x) => x.id === "cyc:a")?.parentId).toBe("nest");
    // A, meanwhile and not yet synced again: `cyc:b` back under Nest, then `cyc:a` made a
    // leaf and spent through. Both before B's move, so both older than the repair.
    let a2 = unwrap(updateAccount(a1, { id: "cyc:b", parentId: "nest" }, T(2)));
    a2 = unwrap(updateAccount(a2, { id: "cyc:a", isPlaceholder: false }, T(3)));
    a2 = spend(a2, "cash", "cyc:a", 100, T(3));
    const merged = mergedBothOrders(repairedBook, a2);
    const member = merged.accounts.find((x) => x.id === "cyc:a");
    expect(member?.parentId).toBe("nest");
    expect(member?.isPlaceholder).toBe(false);
    expect(merged.journal).toHaveLength(1);
  });

  it("cascades the type onto accounts freed from a cycle", () => {
    const seeded = nested(["cyc:a", "cyc:b"]);
    // A moves both under Income while they are still childless — in a real book a retype is
    // a move — then parents `cyc:a` under `cyc:b`. B only parents `cyc:b` under `cyc:a`,
    // keeping both expense.
    let a = unwrap(updateAccount(seeded, { id: "cyc:a", type: "income", parentId: ROOT.income }, T(1)));
    a = unwrap(updateAccount(a, { id: "cyc:b", type: "income", parentId: ROOT.income }, T(1)));
    a = unwrap(updateAccount(a, { id: "cyc:a", parentId: "cyc:b" }, T(2)));
    const b = unwrap(updateAccount(seeded, { id: "cyc:b", parentId: "cyc:a" }, T(3)));
    const merged = mergedBothOrders(a, b);
    // `cyc:a` is cut loose; A's copy points into the cycle, so B's — still under Nest —
    // decides. The cascade then follows it down from Expenses and undoes A's retype.
    expect(merged.accounts.find((x) => x.id === "cyc:a")?.parentId).toBe("nest");
    expect(merged.accounts.find((x) => x.id === "cyc:a")?.type).toBe("expense");
    expect(merged.accounts.find((x) => x.id === "cyc:b")?.type).toBe("expense");
  });

  it("skips an outside parent the other device turned into a posted leaf, and falls through to the type root", () => {
    // `cyc:b` leaves Nest and `cyc:a` moves under it, which empties Nest — legal on A, so A
    // un-flags Nest and spends through it. B, unsynced, only swaps `cyc:a` and `cyc:b`'s
    // places inside Nest. The union ties them into a cycle, and the only outside parent
    // `cyc:a`'s history remembers is Nest — which by now holds a posting and so cannot also
    // take a child. Handing `cyc:a` to it anyway would give Nest both a child and a posting,
    // exactly the pair rung 3 refuses; the rule instead skips a posted candidate and falls
    // through to the type root.
    const seeded = nested(["cyc:a", "cyc:b"]);
    let a = unwrap(updateAccount(seeded, { id: "cyc:b", parentId: ROOT.expense }, T(1)));
    a = unwrap(updateAccount(a, { id: "cyc:a", parentId: "cyc:b" }, T(2)));
    a = unwrap(updateAccount(a, { id: "nest", isPlaceholder: false }, T(3)));
    a = spend(a, "cash", "nest", 100, T(3));
    const b = unwrap(updateAccount(seeded, { id: "cyc:b", parentId: "cyc:a" }, T(2)));

    const merged = mergedBothOrders(a, b);
    // Not "nest": posted, so unusable. Not null: the type root is live and takes no postings.
    expect(merged.accounts.find((x) => x.id === "cyc:a")?.parentId).toBe(ROOT.expense);
    expect(merged.accounts.find((x) => x.id === "cyc:b")?.parentId).toBe("cyc:a");
    expect(merged.accounts.find((x) => x.id === "nest")?.isPlaceholder).toBe(false);
    expect(merged.journal).toHaveLength(1);
    expect(unwrap(mergeBooks(merged, a))).toEqual(merged);
    expect(unwrap(mergeBooks(merged, b))).toEqual(merged);
  });

  it("refuses a currency change under an entry the other device posted", () => {
    const { book, cashId, foodId } = base();
    // A: Food carries no postings here, so changing its currency is legal.
    const a = unwrap(updateAccount(book, { id: foodId, currency: "USD" }, T(1)));
    // B: spends 100 ILS through Food. Union would silently read that 100 as USD.
    const b = spend(book, cashId, foodId, 100, T(2));
    expect(unwrapErr(mergeBooks(a, b)).code).toBe("SYNC_MERGE_CONFLICT");
    expect(unwrapErr(mergeBooks(b, a)).code).toBe("SYNC_MERGE_CONFLICT");
    // The two refusals share a code, so `details` is what tells them apart.
    expect(unwrapErr(mergeBooks(a, b)).details).toEqual({ reason: "currency" });
    expect(unwrapErr(mergeBooks(b, a)).details).toEqual({ reason: "currency" });
  });

  it("refuses a currency change that invalidates a concurrent fx entry", () => {
    const { book, foodId } = base();
    const withUsd = unwrap(createAccount(book, { parentId: ROOT.asset, name: "CashUSD", type: "asset", currency: "USD", isPlaceholder: false }, T(0)));
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

  it("refuses a type change under an entry the other device posted", () => {
    const { book, cashId, foodId } = base();
    // A: Food has no postings here, so retyping it — a move under Income — is legal.
    const a = unwrap(updateAccount(book, { id: foodId, type: "income", parentId: ROOT.income }, T(1)));
    // B: spends 100 through Food. The union would file that spend as income — nothing
    // structural breaks, since a posting records only an account id, but every report
    // classifies by the account's current type.
    const b = spend(book, cashId, foodId, 100, T(2));
    expect(unwrapErr(mergeBooks(a, b)).code).toBe("SYNC_MERGE_CONFLICT");
    expect(unwrapErr(mergeBooks(b, a)).code).toBe("SYNC_MERGE_CONFLICT");
    expect(unwrapErr(mergeBooks(a, b)).details).toEqual({ reason: "accountType" });
    expect(unwrapErr(mergeBooks(b, a)).details).toEqual({ reason: "accountType" });
  });

  it("refuses a type change reached through the parent-type cascade", () => {
    const { book, cashId, groupId } = base();
    // A: a leaf under the Groups placeholder, spent through. Groups itself stays expense.
    const withLeaf = unwrap(createAccount(book, { parentId: groupId, name: "Cafes", type: "expense", currency: "ILS", isPlaceholder: false }, T(1)));
    const cafesId = withLeaf.accounts.find((x) => x.name === "Cafes")!.id;
    const a = spend(withLeaf, cashId, cafesId, 100, T(2));
    // B: Groups is childless and postless here, so retyping the *parent* — a move under
    // Income — is legal. The union hands the cascade a mismatched child and Cafes comes
    // out income.
    const b = unwrap(updateAccount(book, { id: groupId, type: "income", parentId: ROOT.income }, T(3)));
    expect(unwrapErr(mergeBooks(a, b)).details).toEqual({ reason: "accountType" });
    expect(unwrapErr(mergeBooks(b, a)).details).toEqual({ reason: "accountType" });
  });

  it("names currency, not type, when one merge breaks both", () => {
    const { book, cashId, foodId } = base();
    const a = unwrap(updateAccount(book, { id: foodId, type: "income", currency: "USD", parentId: ROOT.income }, T(1)));
    const b = spend(book, cashId, foodId, 100, T(2));
    // Both orders have to pick the same one of the two, or the symmetry property sees a
    // difference the code alone would hide.
    expect(unwrapErr(mergeBooks(a, b)).details).toEqual({ reason: "currency" });
    expect(unwrapErr(mergeBooks(b, a)).details).toEqual({ reason: "currency" });
  });

  it("allows a type change on an account no entry touches", () => {
    const { book, cashId, foodId } = base();
    const spare = unwrap(createAccount(book, { parentId: ROOT.expense, name: "Spare", type: "expense", currency: "ILS", isPlaceholder: false }, T(0)));
    const spareId = spare.accounts.find((x) => x.name === "Spare")!.id;
    const a = unwrap(updateAccount(spare, { id: spareId, type: "income", parentId: ROOT.income }, T(1)));
    const b = spend(spare, cashId, foodId, 100, T(2));
    const merged = mergedBothOrders(a, b);
    expect(merged.accounts.find((x) => x.id === spareId)?.type).toBe("income");
    expect(merged.journal).toHaveLength(1);
  });

  it("allows a currency change on an account no entry touches", () => {
    const { book, cashId, foodId } = base();
    const spare = unwrap(createAccount(book, { parentId: ROOT.asset, name: "Spare", type: "asset", currency: "ILS", isPlaceholder: false }, T(0)));
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
    expect(unwrapErr(mergeBooks(a, b)).details).toEqual({ reason: "childrenAndPostings" });
    expect(unwrapErr(mergeBooks(b, a)).details).toEqual({ reason: "childrenAndPostings" });
  });
});
