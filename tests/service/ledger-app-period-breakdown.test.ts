import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { createLedgerApp } from "../../src/service/ledger-app";
import { unwrap, unwrapErr } from "../helpers";

describe("app.periodBreakdown", () => {
  it("delegates to the kernel query for the seeded Expenses root", async () => {
    const app = createLedgerApp(createMemoryRepository(null));
    const book = unwrap(await app.createHousehold("ILS"));
    const expenses = book.accounts.find((a) => a.name === "Expenses");
    expect(expenses).toBeDefined();
    const result = unwrap(
      app.periodBreakdown(book, { from: "2026-08-01", to: "2026-08-31" }, expenses!.id),
    );
    expect(result).toMatchObject({
      accountId: expenses!.id,
      name: "Expenses",
      isGroup: true,
      currency: "ILS",
      total: 0,
      children: [],
      currencies: [],
      ancestors: [],
    });
  });

  it("propagates kernel errors", async () => {
    const app = createLedgerApp(createMemoryRepository(null));
    const book = unwrap(await app.createHousehold("ILS"));
    const expenses = book.accounts.find((a) => a.name === "Expenses")!;
    expect(
      unwrapErr(
        app.periodBreakdown(book, { from: "nope", to: "2026-08-31" }, expenses.id),
      ).code,
    ).toBe("ENTRY_DATE_INVALID");
  });
});
