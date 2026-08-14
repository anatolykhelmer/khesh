import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { createLedgerApp } from "../../src/service/ledger-app";
import type { Book } from "../../src/kernel";
import { unwrap, unwrapErr } from "../helpers";

async function seeded() {
  const repo = createMemoryRepository(null);
  const app = createLedgerApp(repo);
  const book = unwrap(await app.createHousehold("USD"));
  const assets = book.accounts.find((a) => a.name === "Assets")!;
  const expenses = book.accounts.find((a) => a.name === "Expenses")!;
  return { app, book, assets, expenses };
}

function byName(book: Book, name: string) {
  return book.accounts.find((a) => a.name === name)!;
}

describe("LedgerApp addAccount", () => {
  it("creates a leaf under a root", async () => {
    const { app, book, assets } = await seeded();
    const next = unwrap(
      await app.addAccount(book, { parentId: assets.id, name: "Cash", isPlaceholder: false }),
    );
    expect(byName(next, "Cash")).toMatchObject({
      parentId: assets.id,
      type: "asset",
      isPlaceholder: false,
      currency: "USD",
    });
  });

  it("nests groups and leaves to arbitrary depth", async () => {
    const { app, book, assets } = await seeded();
    let current = unwrap(
      await app.addAccount(book, { parentId: assets.id, name: "Banks", isPlaceholder: true }),
    );
    current = unwrap(
      await app.addAccount(current, {
        parentId: byName(current, "Banks").id,
        name: "Chase",
        isPlaceholder: true,
      }),
    );
    current = unwrap(
      await app.addAccount(current, {
        parentId: byName(current, "Chase").id,
        name: "Checking",
        isPlaceholder: false,
        openingAmount: 25000,
        openingDate: "2026-08-01",
      }),
    );

    const checking = byName(current, "Checking");
    expect(checking.type).toBe("asset");
    expect(unwrap(app.balanceOf(current, checking.id))).toEqual({
      kind: "leaf",
      currency: "USD",
      amount: 25000,
    });
  });

  it("rolls a nested leaf balance up through every ancestor", async () => {
    const { app, book, assets } = await seeded();
    let current = unwrap(
      await app.addAccount(book, { parentId: assets.id, name: "Banks", isPlaceholder: true }),
    );
    current = unwrap(
      await app.addAccount(current, {
        parentId: byName(current, "Banks").id,
        name: "Checking",
        isPlaceholder: false,
        openingAmount: 25000,
        openingDate: "2026-08-01",
      }),
    );

    expect(unwrap(app.balanceOf(current, byName(current, "Banks").id))).toEqual({
      kind: "placeholder",
      balances: { USD: 25000 },
    });
    expect(unwrap(app.balanceOf(current, assets.id))).toEqual({
      kind: "placeholder",
      balances: { USD: 25000 },
    });
  });

  it("inherits the parent type rather than the root type", async () => {
    const { app, book, expenses } = await seeded();
    const next = unwrap(
      await app.addAccount(book, { parentId: expenses.id, name: "Food", isPlaceholder: true }),
    );
    const deeper = unwrap(
      await app.addAccount(next, {
        parentId: byName(next, "Food").id,
        name: "Groceries",
        isPlaceholder: false,
      }),
    );
    expect(byName(deeper, "Groceries").type).toBe("expense");
  });

  it("rejects an opening balance on a group", async () => {
    const { app, book, assets } = await seeded();
    expect(
      unwrapErr(
        await app.addAccount(book, {
          parentId: assets.id,
          name: "Banks",
          isPlaceholder: true,
          openingAmount: 5000,
        }),
      ).code,
    ).toBe("ACCOUNT_IS_PLACEHOLDER");
  });

  it("rejects a leaf as parent", async () => {
    const { app, book, assets } = await seeded();
    const next = unwrap(
      await app.addAccount(book, { parentId: assets.id, name: "Cash", isPlaceholder: false }),
    );
    expect(
      unwrapErr(
        await app.addAccount(next, {
          parentId: byName(next, "Cash").id,
          name: "Wallet",
          isPlaceholder: false,
        }),
      ).code,
    ).toBe("ACCOUNT_PARENT_NOT_PLACEHOLDER");
  });

  it("rejects a missing parent", async () => {
    const { app, book } = await seeded();
    expect(
      unwrapErr(
        await app.addAccount(book, { parentId: "missing", name: "X", isPlaceholder: false }),
      ).code,
    ).toBe("ACCOUNT_PARENT_INVALID");
  });

  it("rejects a system account as parent", async () => {
    const { app, book, assets } = await seeded();
    const next = unwrap(
      await app.addAccount(book, {
        parentId: assets.id,
        name: "Cash",
        isPlaceholder: false,
        openingAmount: 5000,
      }),
    );
    expect(next.accounts.some((a) => a.id === "sys:ob")).toBe(true);
    expect(
      unwrapErr(
        await app.addAccount(next, { parentId: "sys:ob", name: "X", isPlaceholder: false }),
      ).code,
    ).toBe("ACCOUNT_IS_SYSTEM");
  });

  it("creates a leaf in an explicit currency", async () => {
    const { app, book, assets } = await seeded();
    const next = unwrap(
      await app.addAccount(book, {
        parentId: assets.id,
        name: "Euro Account",
        isPlaceholder: false,
        currency: "EUR",
      }),
    );
    expect(byName(next, "Euro Account").currency).toBe("EUR");
  });

  it("falls back to the home currency when no currency is given", async () => {
    const { app, book, assets } = await seeded();
    const next = unwrap(
      await app.addAccount(book, { parentId: assets.id, name: "Cash", isPlaceholder: false }),
    );
    expect(byName(next, "Cash").currency).toBe("USD");
  });

  it("forces groups to the home currency", async () => {
    const { app, book, assets } = await seeded();
    const next = unwrap(
      await app.addAccount(book, {
        parentId: assets.id,
        name: "Banks",
        isPlaceholder: true,
        currency: "EUR",
      }),
    );
    expect(byName(next, "Banks").currency).toBe("USD");
  });

  it("rejects an invalid currency code", async () => {
    const { app, book, assets } = await seeded();
    const result = await app.addAccount(book, {
      parentId: assets.id,
      name: "Bad",
      isPlaceholder: false,
      currency: "eur",
    });
    expect(unwrapErr(result).code).toBe("INVALID_CURRENCY_CODE");
  });

  it("records a foreign-currency opening balance against its own OB leaf", async () => {
    const { app, book, assets } = await seeded();
    const next = unwrap(
      await app.addAccount(book, {
        parentId: assets.id,
        name: "Euro Account",
        isPlaceholder: false,
        currency: "EUR",
        openingAmount: 25000,
        openingDate: "2026-08-01",
      }),
    );
    const leaf = byName(next, "Euro Account");
    const opening = next.journal.find((e) => e.id === `opening:${leaf.id}`)!;
    expect(opening.postings).toHaveLength(2);
    expect(opening.postings.some((p) => p.accountId === "sys:ob:EUR")).toBe(true);
    expect(opening.fx).toBeUndefined();
  });
});

describe("LedgerApp editAccount", () => {
  async function withBranch() {
    const { app, book, assets, expenses } = await seeded();
    let current = unwrap(
      await app.addAccount(book, { parentId: assets.id, name: "Banks", isPlaceholder: true }),
    );
    current = unwrap(
      await app.addAccount(current, {
        parentId: byName(current, "Banks").id,
        name: "Checking",
        isPlaceholder: false,
      }),
    );
    current = unwrap(
      await app.addAccount(current, { parentId: assets.id, name: "Cash", isPlaceholder: true }),
    );
    return { app, book: current, assets, expenses };
  }

  it("renames an account", async () => {
    const { app, book } = await withBranch();
    const next = unwrap(
      await app.editAccount(book, { id: byName(book, "Checking").id, name: "Everyday" }),
    );
    expect(byName(next, "Everyday")).toBeDefined();
  });

  it("moves a branch to another group of the same type", async () => {
    const { app, book } = await withBranch();
    const banks = byName(book, "Banks");
    const cash = byName(book, "Cash");
    const next = unwrap(await app.editAccount(book, { id: banks.id, parentId: cash.id }));
    expect(byName(next, "Banks").parentId).toBe(cash.id);
    expect(byName(next, "Checking").parentId).toBe(banks.id);
  });

  it("rejects moving a group inside its own subtree", async () => {
    const { app, book } = await withBranch();
    const banks = byName(book, "Banks");
    const nested = unwrap(
      await app.addAccount(book, { parentId: banks.id, name: "Sub", isPlaceholder: true }),
    );
    expect(
      unwrapErr(
        await app.editAccount(nested, { id: banks.id, parentId: byName(nested, "Sub").id }),
      ).code,
    ).toBe("ACCOUNT_CYCLE");
  });

  it("rejects moving across account types", async () => {
    const { app, book, expenses } = await withBranch();
    expect(
      unwrapErr(
        await app.editAccount(book, { id: byName(book, "Banks").id, parentId: expenses.id }),
      ).code,
    ).toBe("ACCOUNT_TYPE_MISMATCH");
  });

  it("converts an empty leaf into a group and back", async () => {
    const { app, book } = await withBranch();
    const checking = byName(book, "Checking").id;
    const asGroup = unwrap(await app.editAccount(book, { id: checking, isPlaceholder: true }));
    expect(byName(asGroup, "Checking").isPlaceholder).toBe(true);
    const asLeaf = unwrap(await app.editAccount(asGroup, { id: checking, isPlaceholder: false }));
    expect(byName(asLeaf, "Checking").isPlaceholder).toBe(false);
  });

  it("rejects converting a leaf that already has entries", async () => {
    const { app, book } = await withBranch();
    const posted = unwrap(
      await app.addAccount(book, {
        parentId: byName(book, "Banks").id,
        name: "Savings",
        isPlaceholder: false,
        openingAmount: 1000,
        openingDate: "2026-08-01",
      }),
    );
    expect(
      unwrapErr(
        await app.editAccount(posted, {
          id: byName(posted, "Savings").id,
          isPlaceholder: true,
        }),
      ).code,
    ).toBe("ACCOUNT_HAS_POSTINGS");
  });

  it("rejects converting a group that still has children", async () => {
    const { app, book } = await withBranch();
    expect(
      unwrapErr(
        await app.editAccount(book, { id: byName(book, "Banks").id, isPlaceholder: false }),
      ).code,
    ).toBe("ACCOUNT_HAS_CHILDREN");
  });

  it("protects root categories from being moved or converted", async () => {
    const { app, book, assets } = await withBranch();
    expect(
      unwrapErr(
        await app.editAccount(book, { id: assets.id, parentId: byName(book, "Cash").id }),
      ).code,
    ).toBe("ACCOUNT_IS_SYSTEM");
    expect(
      unwrapErr(await app.editAccount(book, { id: assets.id, isPlaceholder: false })).code,
    ).toBe("ACCOUNT_IS_SYSTEM");
  });
});

describe("LedgerApp removeAccount", () => {
  it("deletes an empty leaf", async () => {
    const { app, book, assets } = await seeded();
    const next = unwrap(
      await app.addAccount(book, { parentId: assets.id, name: "Cash", isPlaceholder: false }),
    );
    const after = unwrap(await app.removeAccount(next, byName(next, "Cash").id));
    expect(after.accounts.some((a) => a.name === "Cash")).toBe(false);
  });

  it("refuses a group with children", async () => {
    const { app, book, assets } = await seeded();
    let next = unwrap(
      await app.addAccount(book, { parentId: assets.id, name: "Banks", isPlaceholder: true }),
    );
    next = unwrap(
      await app.addAccount(next, {
        parentId: byName(next, "Banks").id,
        name: "Checking",
        isPlaceholder: false,
      }),
    );
    expect(unwrapErr(await app.removeAccount(next, byName(next, "Banks").id)).code).toBe(
      "ACCOUNT_HAS_CHILDREN",
    );
  });

  it("refuses a leaf with an opening balance until the entry is gone", async () => {
    const { app, book, assets } = await seeded();
    const next = unwrap(
      await app.addAccount(book, {
        parentId: assets.id,
        name: "Cash",
        isPlaceholder: false,
        openingAmount: 5000,
        openingDate: "2026-08-01",
      }),
    );
    const cash = byName(next, "Cash");
    expect(unwrapErr(await app.removeAccount(next, cash.id)).code).toBe("ACCOUNT_HAS_POSTINGS");

    const cleared = unwrap(await app.deleteEntry(next, `opening:${cash.id}`));
    const after = unwrap(await app.removeAccount(cleared, cash.id));
    expect(after.accounts.some((a) => a.id === cash.id)).toBe(false);
  });

  it("refuses root categories", async () => {
    const { app, book, assets } = await seeded();
    expect(unwrapErr(await app.removeAccount(book, assets.id)).code).toBe("ACCOUNT_IS_SYSTEM");
  });
});

describe("LedgerApp accountTree and parentOptions", () => {
  async function withOpening() {
    const { app, book, assets } = await seeded();
    let current = unwrap(
      await app.addAccount(book, { parentId: assets.id, name: "Banks", isPlaceholder: true }),
    );
    current = unwrap(
      await app.addAccount(current, {
        parentId: byName(current, "Banks").id,
        name: "Checking",
        isPlaceholder: false,
        openingAmount: 5000,
        openingDate: "2026-08-01",
      }),
    );
    return { app, book: current, assets };
  }

  it("nests children and hides system accounts", async () => {
    const { app, book } = await withOpening();
    const tree = unwrap(app.accountTree(book));
    expect(tree.some((node) => node.id === "sys:ob")).toBe(false);
    const assets = tree.find((node) => node.name === "Assets")!;
    const banks = assets.children.find((node) => node.name === "Banks")!;
    expect(banks.children.map((node) => node.name)).toEqual(["Checking"]);
  });

  it("offers every group of the matching type, by path", async () => {
    const { app, book } = await withOpening();
    const options = app.parentOptions(book, { type: "asset" });
    expect(options.map((o) => o.path)).toEqual(["Assets", "Assets:Banks"]);
    expect(options.map((o) => o.depth)).toEqual([0, 1]);
  });

  it("excludes the moved account and its subtree", async () => {
    const { app, book } = await withOpening();
    const options = app.parentOptions(book, { forAccountId: byName(book, "Banks").id });
    expect(options.map((o) => o.path)).toEqual(["Assets"]);
  });

  it("never offers system groups", async () => {
    const { app, book } = await withOpening();
    const options = app.parentOptions(book, { type: "equity" });
    expect(options.map((o) => o.id)).not.toContain("sys:ob");
  });
});
