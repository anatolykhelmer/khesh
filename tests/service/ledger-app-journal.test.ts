import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { createLedgerApp } from "../../src/service/ledger-app";
import { unwrap } from "../helpers";

async function seeded() {
  const repo = createMemoryRepository(null);
  const app = createLedgerApp(repo);
  let book = unwrap(await app.createHousehold("ILS"));
  const assets = book.accounts.find((a) => a.name === "Assets")!;
  const expenses = book.accounts.find((a) => a.name === "Expenses")!;

  book = unwrap(
    await app.addAccount(book, { parentId: assets.id, name: "Cash", isPlaceholder: false }),
  );
  book = unwrap(
    await app.addAccount(book, { parentId: expenses.id, name: "Home", isPlaceholder: true }),
  );
  const home = book.accounts.find((a) => a.name === "Home")!;
  book = unwrap(
    await app.addAccount(book, { parentId: home.id, name: "Rent", isPlaceholder: false }),
  );

  const cash = book.accounts.find((a) => a.name === "Cash")!;
  const rent = book.accounts.find((a) => a.name === "Rent")!;

  book = unwrap(
    await app.addEntry(book, {
      date: "2026-01-15",
      description: "January rent",
      fromAccountId: cash.id,
      lines: [{ toAccountId: rent.id, amount: 5000 }],
    }),
  );
  book = unwrap(
    await app.addEntry(book, {
      date: "2026-02-20",
      description: "February rent",
      fromAccountId: cash.id,
      lines: [{ toAccountId: rent.id, amount: 5000 }],
    }),
  );

  return { app, book, expenses, cash, rent };
}

describe("LedgerApp listJournal", () => {
  it("returns everything when no filter is given", async () => {
    const { app, book } = await seeded();
    expect(unwrap(app.listJournal(book))).toHaveLength(2);
  });

  it("narrows by date range", async () => {
    const { app, book } = await seeded();
    const listed = unwrap(app.listJournal(book, { from: "2026-02-01", to: "2026-02-28" }));
    expect(listed).toHaveLength(1);
    expect(listed[0].description).toBe("February rent");
  });

  it("narrows by account, covering a group's subtree", async () => {
    const { app, book, expenses } = await seeded();
    expect(unwrap(app.listJournal(book, { accountId: expenses.id }))).toHaveLength(2);
  });

  it("combines date and account", async () => {
    const { app, book, expenses } = await seeded();
    const listed = unwrap(
      app.listJournal(book, { from: "2026-01-01", to: "2026-01-31", accountId: expenses.id }),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0].description).toBe("January rent");
  });
});
