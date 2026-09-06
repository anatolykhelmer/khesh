import { describe, expect, it } from "vitest";
import { accountFigure, monthFigureLabel } from "../../src/app/account-figure";

const MID_AUGUST = new Date(2026, 7, 16); // local time

describe("accountFigure", () => {
  it("shows the running balance for assets, liabilities and equity", () => {
    expect(accountFigure("asset", MID_AUGUST)).toEqual({ kind: "balance" });
    expect(accountFigure("liability", MID_AUGUST)).toEqual({ kind: "balance" });
    expect(accountFigure("equity", MID_AUGUST)).toEqual({ kind: "balance" });
  });

  it("shows the current calendar month for income and expenses", () => {
    const expected = {
      kind: "month",
      year: 2026,
      month: 8,
      range: { from: "2026-08-01", to: "2026-08-31" },
    };
    expect(accountFigure("income", MID_AUGUST)).toEqual(expected);
    expect(accountFigure("expense", MID_AUGUST)).toEqual(expected);
  });

  it("rolls to the next month on its first day", () => {
    expect(accountFigure("expense", new Date(2026, 7, 31))).toMatchObject({
      range: { from: "2026-08-01", to: "2026-08-31" },
    });
    expect(accountFigure("expense", new Date(2026, 8, 1))).toMatchObject({
      year: 2026,
      month: 9,
      range: { from: "2026-09-01", to: "2026-09-30" },
    });
  });
});

describe("monthFigureLabel", () => {
  it("composes the localized month name and the year", () => {
    expect(monthFigureLabel({ year: 2026, month: 9 })).toBe("September 2026");
    expect(monthFigureLabel({ year: 2025, month: 1 })).toBe("January 2025");
  });
});
