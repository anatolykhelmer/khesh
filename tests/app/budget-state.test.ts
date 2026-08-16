import { describe, expect, it } from "vitest";
import {
  budgetRange,
  parseBudgetState,
  setPeriodKind,
  shiftBudgetState,
  toBudgetParams,
} from "../../src/app/budget-state";

const NOW = new Date(2026, 7, 16); // August 2026, local time

describe("parseBudgetState", () => {
  it("defaults to the current month", () => {
    expect(parseBudgetState(new URLSearchParams(), NOW)).toEqual({
      period: "month",
      year: 2026,
      month: 8,
    });
  });

  it("reads a month", () => {
    expect(parseBudgetState(new URLSearchParams("period=month&month=2025-03"), NOW)).toEqual({
      period: "month",
      year: 2025,
      month: 3,
    });
  });

  it("reads a year, keeping the current month for a later switch back", () => {
    expect(parseBudgetState(new URLSearchParams("period=year&year=2024"), NOW)).toEqual({
      period: "year",
      year: 2024,
      month: 8,
    });
  });

  it("falls back to the current period on junk", () => {
    expect(parseBudgetState(new URLSearchParams("period=month&month=2026-13"), NOW)).toEqual({
      period: "month",
      year: 2026,
      month: 8,
    });
    expect(parseBudgetState(new URLSearchParams("period=year&year=nope"), NOW)).toEqual({
      period: "year",
      year: 2026,
      month: 8,
    });
  });
});

describe("toBudgetParams", () => {
  it("writes the month in monthly mode", () => {
    expect(toBudgetParams({ period: "month", year: 2026, month: 3 }).toString()).toBe(
      "period=month&month=2026-03",
    );
  });

  it("writes the year in annual mode", () => {
    expect(toBudgetParams({ period: "year", year: 2026, month: 3 }).toString()).toBe(
      "period=year&year=2026",
    );
  });
});

describe("shiftBudgetState", () => {
  it("steps months and rolls the year", () => {
    expect(shiftBudgetState({ period: "month", year: 2026, month: 1 }, -1)).toEqual({
      period: "month",
      year: 2025,
      month: 12,
    });
  });

  it("steps years in annual mode", () => {
    expect(shiftBudgetState({ period: "year", year: 2026, month: 8 }, 1)).toEqual({
      period: "year",
      year: 2027,
      month: 8,
    });
  });
});

describe("setPeriodKind", () => {
  it("keeps the year when switching to annual", () => {
    expect(setPeriodKind({ period: "month", year: 2024, month: 3 }, "year", NOW)).toEqual({
      period: "year",
      year: 2024,
      month: 3,
    });
  });

  it("keeps the year and resets to the current month when switching to monthly", () => {
    expect(setPeriodKind({ period: "year", year: 2024, month: 3 }, "month", NOW)).toEqual({
      period: "month",
      year: 2024,
      month: 8,
    });
  });
});

describe("budgetRange", () => {
  it("returns the month range in monthly mode", () => {
    expect(budgetRange({ period: "month", year: 2026, month: 2 })).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
  });

  it("returns the year range in annual mode", () => {
    expect(budgetRange({ period: "year", year: 2026, month: 2 })).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
    });
  });
});
