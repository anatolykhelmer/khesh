import { describe, expect, it } from "vitest";
import {
  currentYearMonth,
  formatYearMonth,
  monthRange,
  shiftYearMonth,
  yearRange,
} from "../../src/service/dates";

describe("currentYearMonth", () => {
  it("reads year and 1-based month from a given date", () => {
    expect(currentYearMonth(new Date(2026, 7, 12))).toEqual({ year: 2026, month: 8 });
  });

  it("handles January correctly (month index 0)", () => {
    expect(currentYearMonth(new Date(2026, 0, 1))).toEqual({ year: 2026, month: 1 });
  });
});

describe("monthRange", () => {
  it("returns first/last day for a 31-day month", () => {
    expect(monthRange(2026, 8)).toEqual({ from: "2026-08-01", to: "2026-08-31" });
  });

  it("returns first/last day for a 30-day month", () => {
    expect(monthRange(2026, 4)).toEqual({ from: "2026-04-01", to: "2026-04-30" });
  });

  it("returns 28 days for February in a non-leap year", () => {
    expect(monthRange(2026, 2)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("returns 29 days for February in a leap year", () => {
    expect(monthRange(2024, 2)).toEqual({ from: "2024-02-01", to: "2024-02-29" });
  });
});

describe("shiftYearMonth", () => {
  it("steps forward within a year", () => {
    expect(shiftYearMonth({ year: 2026, month: 8 }, 1)).toEqual({ year: 2026, month: 9 });
  });

  it("rolls over into the next year", () => {
    expect(shiftYearMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
  });

  it("rolls back into the previous year", () => {
    expect(shiftYearMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
  });
});

describe("formatYearMonth", () => {
  it("zero-pads the month", () => {
    expect(formatYearMonth({ year: 2026, month: 3 })).toBe("2026-03");
  });

  it("leaves a two-digit month alone", () => {
    expect(formatYearMonth({ year: 2026, month: 11 })).toBe("2026-11");
  });
});

describe("yearRange", () => {
  it("spans the whole calendar year", () => {
    expect(yearRange(2026)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });
});
