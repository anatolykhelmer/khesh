import { describe, expect, it } from "vitest";
import { createLedgerApp } from "../../src/service/ledger-app";
import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { balance } from "../../src/kernel/queries";
import { recurrenceEntryId } from "../../src/kernel/occurrences";
import type { Book } from "../../src/kernel/types";
import { unwrap, unwrapErr, NOW } from "../helpers";

const TODAY = "2026-06-15";

const schedule = { every: 1, unit: "month" as const, startDate: "2026-04-01", endDate: null };

/** One app, one repository, one book with a rule already on it. Every test starts here —
 * calling this twice would hand back two unrelated repositories. */
async function withRule() {
  const app = createLedgerApp(createMemoryRepository(), { now: () => NOW });
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
      ...schedule,
    }),
  );
  return { app, book, bank, rent, ruleId: book.recurrences[0].id };
}

function leafAmount(book: Book, accountId: string): number | null {
  const result = unwrap(balance(book, accountId));
  return result.kind === "leaf" ? result.amount : null;
}

describe("recurrences through LedgerApp", () => {
  it("derives due rows with a renderable preview", async () => {
    const { app, book } = await withRule();
    const rows = app.dueRows(book, TODAY);
    expect(rows.map((r) => r.date)).toEqual(["2026-04-01", "2026-05-01", "2026-06-01"]);
    expect(rows[0].description).toBe("Rent");
    expect(rows[0].currency).toBe("ILS");
    expect(rows[0].total).toBe(300000);
    expect(rows[0].preview.id).toBe(rows[0].entryId);
    expect(rows[0].preview.postings).toHaveLength(2);
  });

  it("a due row is not money: balances ignore it entirely", async () => {
    const { app, book, rent, ruleId } = await withRule();
    // Post one genuine occurrence, so the account carries a specific, non-zero balance —
    // then confirm the *other* occurrences still sitting in the queue never touch it.
    const posted = unwrap(await app.postOccurrence(book, ruleId, "2026-04-01"));
    const rows = app.dueRows(posted, TODAY);
    expect(rows.map((r) => r.date)).toEqual(["2026-05-01", "2026-06-01"]);
    expect(leafAmount(posted, rent.id)).toBe(300000);
  });

  it("posts one occurrence under its deterministic id and removes it from the queue", async () => {
    const { app, book, rent, ruleId } = await withRule();
    const next = unwrap(await app.postOccurrence(book, ruleId, "2026-05-01"));

    expect(next.journal.map((e) => e.id)).toContain(recurrenceEntryId(ruleId, "2026-05-01"));
    expect(app.dueRows(next, TODAY).map((r) => r.date)).toEqual(["2026-04-01", "2026-06-01"]);
    expect(leafAmount(next, rent.id)).toBe(300000);
  });

  it("applies overrides but keeps the occurrence's own id", async () => {
    const { app, book, rent, ruleId } = await withRule();
    const next = unwrap(
      await app.postOccurrence(book, ruleId, "2026-05-01", {
        date: "2026-05-03",
        lines: [{ toAccountId: rent.id, amount: 310000 }],
      }),
    );
    const entry = next.journal.find((e) => e.id === recurrenceEntryId(ruleId, "2026-05-01"))!;
    // The occurrence date is what the id is built from; the entry's own date is free.
    expect(entry.date).toBe("2026-05-03");
    expect(entry.postings.find((p) => p.side === "debit")!.amount).toBe(310000);
    expect(app.dueRows(next, TODAY).map((r) => r.date)).toEqual(["2026-04-01", "2026-06-01"]);
  });

  // The rule itself must be same-currency (RECURRENCE_CURRENCY_MISMATCH refuses
  // otherwise), but the post screen's account picker lets the user redirect a single
  // occurrence to a different-currency account before confirming it, and that reaches
  // `invalidEntryInput`'s cross-currency branch, which requires `fromAmount`.
  it("forwards a fromAmount override so a redirected occurrence can post cross-currency", async () => {
    const { app, book, ruleId } = await withRule();
    const assets = book.accounts.find((a) => a.type === "asset" && a.parentId === null)!;
    const withUsd = unwrap(
      await app.addAccount(book, {
        parentId: assets.id,
        name: "USD Card",
        isPlaceholder: false,
        currency: "USD",
      }),
    );
    const usdCard = withUsd.accounts.find((a) => a.name === "USD Card")!;

    const next = unwrap(
      await app.postOccurrence(withUsd, ruleId, "2026-04-01", {
        fromAccountId: usdCard.id,
        fromAmount: 82000,
      }),
    );

    const entry = next.journal.find((e) => e.id === recurrenceEntryId(ruleId, "2026-04-01"))!;
    expect(entry.fx).toEqual({
      baseCurrency: "USD",
      baseAmount: 82000,
      quoteCurrency: "ILS",
      quoteAmount: 300000,
    });
    expect(entry.postings.find((p) => p.side === "credit")).toEqual({
      accountId: usdCard.id,
      side: "credit",
      amount: 82000,
    });
  });

  it("refuses to post from a rule that does not exist", async () => {
    const { app, book } = await withRule();
    expect(unwrapErr(await app.postOccurrence(book, "nope", "2026-05-01")).code).toBe(
      "RECURRENCE_NOT_FOUND",
    );
  });

  it("round-trips rules through export and import", async () => {
    const { app, book } = await withRule();
    const restored = unwrap(await app.importJson(app.exportJson(book)));
    expect(restored.recurrences).toEqual(book.recurrences);
  });
});
