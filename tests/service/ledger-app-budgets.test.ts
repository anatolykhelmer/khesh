import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { monthRange } from "../../src/service/dates";
import { createLedgerApp } from "../../src/service/ledger-app";
import { NOW, unwrap, unwrapErr } from "../helpers";

const MONTH = monthRange(2026, 8);

async function household() {
  const repo = createMemoryRepository(null);
  const app = createLedgerApp(repo, { now: () => NOW });
  const book = unwrap(await app.createHousehold("ILS"));
  const expenses = book.accounts.find((a) => a.name === "Expenses")!;
  return { repo, app, book, expenses };
}

describe("app.setBudget", () => {
  it("persists the limit through the repository", async () => {
    const { repo, app, book, expenses } = await household();
    const next = unwrap(
      await app.setBudget(book, {
        accountId: expenses.id,
        period: "month",
        currency: "ILS",
        limit: 400000,
      }),
    );
    const expected = [
      { accountId: expenses.id, period: "month", currency: "ILS", limit: 400000, updatedAt: NOW },
    ];
    expect(next.budgets).toEqual(expected);
    expect(unwrap(await repo.load())?.budgets).toEqual(expected);
  });

  it("propagates kernel errors", async () => {
    const { app, book, expenses } = await household();
    expect(
      unwrapErr(
        await app.setBudget(book, {
          accountId: expenses.id,
          period: "month",
          currency: "ILS",
          limit: 0,
        }),
      ).code,
    ).toBe("BUDGET_LIMIT_INVALID");
  });
});

describe("app.removeBudget", () => {
  it("persists the removal", async () => {
    const { repo, app, book, expenses } = await household();
    const withLimit = unwrap(
      await app.setBudget(book, {
        accountId: expenses.id,
        period: "month",
        currency: "ILS",
        limit: 400000,
      }),
    );
    const without = unwrap(
      await app.removeBudget(withLimit, {
        accountId: expenses.id,
        period: "month",
        currency: "ILS",
      }),
    );
    expect(without.budgets).toEqual([]);
    expect(unwrap(await repo.load())?.budgets).toEqual([]);
  });

  it("propagates kernel errors", async () => {
    const { app, book, expenses } = await household();
    expect(
      unwrapErr(
        await app.removeBudget(book, {
          accountId: expenses.id,
          period: "month",
          currency: "ILS",
        }),
      ).code,
    ).toBe("BUDGET_NOT_FOUND");
  });
});

describe("app.budgetReport", () => {
  it("delegates to the kernel query", async () => {
    const { app, book, expenses } = await household();
    const withLimit = unwrap(
      await app.setBudget(book, {
        accountId: expenses.id,
        period: "month",
        currency: "ILS",
        limit: 400000,
      }),
    );
    const report = unwrap(app.budgetReport(withLimit, "month", MONTH));
    expect(report.period).toBe("month");
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ accountId: expenses.id, spent: 0, remaining: 400000 });
    expect(report.unbudgeted).toEqual({});
  });

  it("propagates kernel errors", async () => {
    const { app, book } = await household();
    expect(
      unwrapErr(app.budgetReport(book, "month", { from: "nope", to: "2026-08-31" })).code,
    ).toBe("ENTRY_DATE_INVALID");
  });
});
