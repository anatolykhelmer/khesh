import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "../../src/adapters/memory-repository";
import type { LedgerRepository } from "../../src/ports/ledger-repository";
import { createLedgerApp } from "../../src/service/ledger-app";
import type { Book } from "../../src/kernel/types";
import { NOW, unwrap } from "../helpers";

function countingRepository(): { repo: LedgerRepository; saves: () => number } {
  const inner = createMemoryRepository(null);
  let saves = 0;
  return {
    repo: {
      load: () => inner.load(),
      save: (book) => {
        saves += 1;
        return inner.save(book);
      },
      clear: () => inner.clear(),
    },
    saves: () => saves,
  };
}

async function withRule() {
  const { repo, saves } = countingRepository();
  const commits: Book[] = [];
  const app = createLedgerApp(repo, { now: () => NOW, afterCommit: (b) => commits.push(b) });
  let book = unwrap(await app.createHousehold("ILS"));
  const assets = book.accounts.find((a) => a.type === "asset" && a.parentId === null)!;
  const expenses = book.accounts.find((a) => a.type === "expense" && a.parentId === null)!;
  book = unwrap(await app.addAccount(book, { parentId: assets.id, name: "Bank", isPlaceholder: false, currency: "ILS" }));
  book = unwrap(await app.addAccount(book, { parentId: expenses.id, name: "Rent", isPlaceholder: false, currency: "ILS" }));
  const bank = book.accounts.find((a) => a.name === "Bank")!;
  const rent = book.accounts.find((a) => a.name === "Rent")!;
  book = unwrap(
    await app.addRecurrence(book, {
      description: "Rent",
      fromAccountId: bank.id,
      lines: [{ toAccountId: rent.id, amount: 300000 }],
      every: 1,
      unit: "month",
      startDate: "2026-04-01",
      endDate: null,
    }),
  );
  const savesBefore = saves();
  commits.length = 0;
  return { app, book, rent, ruleId: book.recurrences[0].id, commits, savesSince: () => saves() - savesBefore };
}

describe("a no-op command through LedgerApp", () => {
  it("re-pausing a paused rule saves nothing and fires no afterCommit", async () => {
    const { app, book, ruleId, commits, savesSince } = await withRule();
    const paused = unwrap(await app.setRecurrencePaused(book, ruleId, true));
    expect(paused).not.toBe(book);
    expect(savesSince()).toBe(1);
    expect(commits).toHaveLength(1);

    const again = unwrap(await app.setRecurrencePaused(paused, ruleId, true));
    expect(again).toBe(paused);
    expect(savesSince()).toBe(1);
    expect(commits).toHaveLength(1);
  });

  it("editing an account to its current name saves nothing", async () => {
    const { app, book, rent, commits, savesSince } = await withRule();
    const same = unwrap(await app.editAccount(book, { id: rent.id, name: "Rent" }));
    expect(same).toBe(book);
    expect(savesSince()).toBe(0);
    expect(commits).toHaveLength(0);
  });

  it("a real edit still saves once and fires afterCommit once", async () => {
    const { app, book, rent, commits, savesSince } = await withRule();
    const renamed = unwrap(await app.editAccount(book, { id: rent.id, name: "Housing" }));
    expect(renamed).not.toBe(book);
    expect(savesSince()).toBe(1);
    expect(commits).toEqual([renamed]);
  });
});
