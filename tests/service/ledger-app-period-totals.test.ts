import { describe, expect, it } from "vitest";
import { createBook } from "../../src/kernel/create-book";
import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { createLedgerApp } from "../../src/service/ledger-app";
import { unwrap, unwrapErr } from "../helpers";

describe("app.periodTotals", () => {
  it("delegates to the kernel query and returns zero totals for an empty book", async () => {
    const app = createLedgerApp(createMemoryRepository(null));
    const book = unwrap(await app.createHousehold("ILS"));
    const totals = unwrap(app.periodTotals(book, { from: "2026-08-01", to: "2026-08-31" }));
    expect(totals).toEqual({ ILS: { income: 0, expense: 0 } });
  });

  it("propagates kernel errors for an invalid range", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
    const app = createLedgerApp(createMemoryRepository(null));
    expect(unwrapErr(app.periodTotals(book, { from: "nope", to: "2026-08-31" })).code).toBe(
      "ENTRY_DATE_INVALID",
    );
  });
});
