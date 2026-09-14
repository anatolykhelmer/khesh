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
  return { app, book, assets };
}

function byName(book: Book, name: string) {
  return book.accounts.find((a) => a.name === name)!;
}

describe("LedgerApp openingBalanceOf", () => {
  it("returns undefined when no opening entry exists", async () => {
    const { app, book, assets } = await seeded();
    const next = unwrap(
      await app.addAccount(book, { parentId: assets.id, name: "Cash", isPlaceholder: false }),
    );
    expect(app.openingBalanceOf(next, byName(next, "Cash").id)).toBeUndefined();
  });

  it("returns the amount and date of an existing opening entry", async () => {
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
    expect(app.openingBalanceOf(next, byName(next, "Cash").id)).toEqual({
      amount: 5000,
      date: "2026-08-01",
    });
  });
});

describe("LedgerApp setOpeningBalance", () => {
  it("creates an opening entry on an account that has none", async () => {
    const { app, book, assets } = await seeded();
    const next = unwrap(
      await app.addAccount(book, { parentId: assets.id, name: "Cash", isPlaceholder: false }),
    );
    const cash = byName(next, "Cash").id;
    const after = unwrap(
      await app.setOpeningBalance(next, { accountId: cash, amount: 3000, date: "2026-08-01" }),
    );
    expect(app.openingBalanceOf(after, cash)).toEqual({ amount: 3000, date: "2026-08-01" });
  });

  it("updates the amount and date of an existing opening entry in place", async () => {
    const { app, book, assets } = await seeded();
    const next = unwrap(
      await app.addAccount(book, {
        parentId: assets.id,
        name: "Cash",
        isPlaceholder: false,
        openingAmount: 3000,
        openingDate: "2026-08-01",
      }),
    );
    const cash = byName(next, "Cash").id;
    const after = unwrap(
      await app.setOpeningBalance(next, { accountId: cash, amount: 7500, date: "2026-08-15" }),
    );
    expect(app.openingBalanceOf(after, cash)).toEqual({ amount: 7500, date: "2026-08-15" });
    expect(after.journal.filter((e) => e.id === `opening:${cash}`)).toHaveLength(1);
  });

  it("deletes the opening entry when the amount is set to 0", async () => {
    const { app, book, assets } = await seeded();
    const next = unwrap(
      await app.addAccount(book, {
        parentId: assets.id,
        name: "Cash",
        isPlaceholder: false,
        openingAmount: 3000,
        openingDate: "2026-08-01",
      }),
    );
    const cash = byName(next, "Cash").id;
    const after = unwrap(
      await app.setOpeningBalance(next, { accountId: cash, amount: 0, date: "2026-08-01" }),
    );
    expect(app.openingBalanceOf(after, cash)).toBeUndefined();
    expect(after.journal.some((e) => e.id === `opening:${cash}`)).toBe(false);
  });

  it("is a no-op when set to 0 on an account with no opening entry", async () => {
    const { app, book, assets } = await seeded();
    const next = unwrap(
      await app.addAccount(book, { parentId: assets.id, name: "Cash", isPlaceholder: false }),
    );
    const cash = byName(next, "Cash").id;
    const after = unwrap(
      await app.setOpeningBalance(next, { accountId: cash, amount: 0, date: "2026-08-01" }),
    );
    expect(after.journal.some((e) => e.id === `opening:${cash}`)).toBe(false);
  });

  it("rejects a placeholder account", async () => {
    const { app, book, assets } = await seeded();
    const next = unwrap(
      await app.addAccount(book, { parentId: assets.id, name: "Banks", isPlaceholder: true }),
    );
    const banks = byName(next, "Banks").id;
    expect(
      unwrapErr(
        await app.setOpeningBalance(next, { accountId: banks, amount: 1000, date: "2026-08-01" }),
      ).code,
    ).toBe("ACCOUNT_IS_PLACEHOLDER");
  });

  it("rejects a system account", async () => {
    const { app, book, assets } = await seeded();
    const next = unwrap(
      await app.addAccount(book, {
        parentId: assets.id,
        name: "Cash",
        isPlaceholder: false,
        openingAmount: 1000,
        openingDate: "2026-08-01",
      }),
    );
    expect(
      unwrapErr(
        await app.setOpeningBalance(next, { accountId: "sys:ob", amount: 500, date: "2026-08-01" }),
      ).code,
    ).toBe("ACCOUNT_IS_SYSTEM");
  });

  it("rejects an invalid date", async () => {
    const { app, book, assets } = await seeded();
    const next = unwrap(
      await app.addAccount(book, { parentId: assets.id, name: "Cash", isPlaceholder: false }),
    );
    const cash = byName(next, "Cash").id;
    expect(
      unwrapErr(
        await app.setOpeningBalance(next, { accountId: cash, amount: 1000, date: "not-a-date" }),
      ).code,
    ).toBe("ENTRY_DATE_INVALID");
  });
});
