import { createAccount, deleteAccount, updateAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { deleteEntry, postEntry, updateEntry } from "../../src/kernel/journal";
import { removeBudget, setBudget } from "../../src/kernel/budgets";
import { recordOpeningBalance } from "../../src/kernel/opening";
import { EPOCH, normalizeBook } from "../../src/kernel/normalize";
import { budgetKeyOf } from "../../src/kernel/tombstones";
import { LATER, NOW, unwrap } from "../helpers";

function baseBook() {
  let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
  book = unwrap(
    createAccount(book, { parentId: null, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false }, NOW),
  );
  book = unwrap(
    createAccount(book, { parentId: null, name: "Food", type: "expense", currency: "ILS", isPlaceholder: false }, NOW),
  );
  return { book, cashId: book.accounts[0].id, foodId: book.accounts[1].id };
}

describe("schema v2 stamping", () => {
  it("createBook stamps schemaVersion 2, metaUpdatedAt and empty tombstones", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    expect(book.schemaVersion).toBe(2);
    expect(book.metaUpdatedAt).toBe(NOW);
    expect(book.tombstones).toEqual([]);
  });

  it("create/update stamp updatedAt on the touched record only", () => {
    const { book, cashId } = baseBook();
    expect(book.accounts.every((a) => a.updatedAt === NOW)).toBe(true);
    const renamed = unwrap(updateAccount(book, { id: cashId, name: "Wallet" }, LATER));
    expect(renamed.accounts.find((a) => a.id === cashId)?.updatedAt).toBe(LATER);
    expect(renamed.accounts.find((a) => a.id !== cashId)?.updatedAt).toBe(NOW);
  });

  it("deleteAccount writes an account tombstone with the snapshot and takes budget tombstones along", () => {
    const { book, foodId } = baseBook();
    const withBudget = unwrap(
      setBudget(book, { accountId: foodId, period: "month", currency: "ILS", limit: 100 }, NOW),
    );
    const deleted = unwrap(deleteAccount(withBudget, foodId, LATER));
    const accountStone = deleted.tombstones.find((t) => t.kind === "account" && t.key === foodId);
    expect(accountStone?.deletedAt).toBe(LATER);
    expect((accountStone?.record as { name: string }).name).toBe("Food");
    const budgetStone = deleted.tombstones.find((t) => t.kind === "budget");
    expect(budgetStone?.key).toBe(budgetKeyOf({ accountId: foodId, period: "month", currency: "ILS" }));
  });

  it("postEntry/updateEntry/deleteEntry stamp and tombstone", () => {
    const { book, cashId, foodId } = baseBook();
    let next = unwrap(
      postEntry(book, {
        date: "2026-01-10",
        description: "Groceries",
        postings: [
          { accountId: foodId, side: "debit", amount: 500 },
          { accountId: cashId, side: "credit", amount: 500 },
        ],
      }, NOW),
    );
    const entryId = next.journal[0].id;
    expect(next.journal[0].updatedAt).toBe(NOW);
    next = unwrap(updateEntry(next, { id: entryId, description: "Market" }, LATER));
    expect(next.journal[0].updatedAt).toBe(LATER);
    next = unwrap(deleteEntry(next, entryId, LATER));
    expect(next.journal).toHaveLength(0);
    expect(next.tombstones[0]).toMatchObject({ kind: "entry", key: entryId, deletedAt: LATER });
  });

  it("setBudget upsert clears a matching budget tombstone", () => {
    const { book, foodId } = baseBook();
    const key = { accountId: foodId, period: "month" as const, currency: "ILS" };
    let next = unwrap(setBudget(book, { ...key, limit: 100 }, NOW));
    next = unwrap(removeBudget(next, key, NOW));
    expect(next.tombstones.some((t) => t.kind === "budget")).toBe(true);
    next = unwrap(setBudget(next, { ...key, limit: 200 }, LATER));
    expect(next.tombstones.some((t) => t.kind === "budget")).toBe(false);
    expect(next.budgets[0]).toMatchObject({ limit: 200, updatedAt: LATER });
  });

  it("recordOpeningBalance stamps the upserted entry and system accounts; zeroing tombstones the entry", () => {
    const { book, cashId } = baseBook();
    let next = unwrap(recordOpeningBalance(book, { accountId: cashId, amount: 700, date: "2026-01-01" }, NOW));
    const entry = next.journal.find((e) => e.id === `opening:${cashId}`);
    expect(entry?.updatedAt).toBe(NOW);
    expect(next.accounts.find((a) => a.id === "sys:ob")?.updatedAt).toBe(NOW);
    next = unwrap(recordOpeningBalance(next, { accountId: cashId, amount: 0, date: "2026-01-01" }, LATER));
    expect(next.tombstones.some((t) => t.kind === "entry" && t.key === `opening:${cashId}`)).toBe(true);
    // re-setting resurrects: the tombstone must be cleared again
    next = unwrap(recordOpeningBalance(next, { accountId: cashId, amount: 900, date: "2026-01-01" }, LATER));
    expect(next.tombstones.some((t) => t.kind === "entry")).toBe(false);
  });
});

describe("v1 -> v2 migration", () => {
  it("normalizeBook epoch-stamps a v1 book and adds tombstones", () => {
    const v1 = {
      schemaVersion: 1,
      name: "Home",
      homeCurrency: "ILS",
      accounts: [
        { id: "a1", parentId: null, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false },
      ],
      journal: [],
      budgets: [{ accountId: "a1", period: "month", currency: "ILS", limit: 5 }],
    };
    const book = normalizeBook(v1 as any);
    expect(book.schemaVersion).toBe(2);
    expect(book.metaUpdatedAt).toBe(EPOCH);
    expect(book.accounts[0].updatedAt).toBe(EPOCH);
    expect(book.budgets[0].updatedAt).toBe(EPOCH);
    expect(book.tombstones).toEqual([]);
  });

  it("normalizeBook leaves a v2 book alone", () => {
    const { book } = baseBook();
    expect(normalizeBook(book)).toEqual(book);
  });
});
