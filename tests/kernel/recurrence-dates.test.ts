import { describe, expect, it } from "vitest";
import {
  occurrenceDate,
  occurrencesBetween,
  shiftMonths,
} from "../../src/kernel/recurrence-dates";

describe("occurrenceDate", () => {
  it("returns the start date at k = 0", () => {
    expect(occurrenceDate("2026-01-31", 1, "month", 0)).toBe("2026-01-31");
  });

  it("clamps the 31st per month but recomputes from the start, never from the last result", () => {
    // The bug this forbids: 31 Jan -> 28 Feb -> 28 Mar (pinned forever after one February).
    expect(occurrenceDate("2026-01-31", 1, "month", 1)).toBe("2026-02-28");
    expect(occurrenceDate("2026-01-31", 1, "month", 2)).toBe("2026-03-31");
    expect(occurrenceDate("2026-01-31", 1, "month", 3)).toBe("2026-04-30");
  });

  it("clamps into a leap February", () => {
    expect(occurrenceDate("2028-01-31", 1, "month", 1)).toBe("2028-02-29");
  });

  it("steps whole weeks across a year boundary", () => {
    expect(occurrenceDate("2026-12-20", 2, "week", 1)).toBe("2027-01-03");
  });

  it("steps years and clamps a 29 February start in a common year", () => {
    expect(occurrenceDate("2028-02-29", 1, "year", 1)).toBe("2029-02-28");
    expect(occurrenceDate("2028-02-29", 4, "year", 1)).toBe("2032-02-29");
  });

  it("steps several months at a time", () => {
    expect(occurrenceDate("2026-01-15", 3, "month", 4)).toBe("2027-01-15");
  });
});

describe("occurrencesBetween", () => {
  it("returns the dates inside an inclusive range, ascending", () => {
    expect(occurrencesBetween("2026-01-01", 1, "month", "2026-03-01", "2026-05-01")).toEqual([
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
    ]);
  });

  it("never returns a date before the start date", () => {
    expect(occurrencesBetween("2026-04-01", 1, "month", "2026-01-01", "2026-05-01")).toEqual([
      "2026-04-01",
      "2026-05-01",
    ]);
  });

  it("is empty when the range ends before the start date", () => {
    expect(occurrencesBetween("2026-04-01", 1, "month", "2026-01-01", "2026-03-01")).toEqual([]);
  });

  it("is empty when the range is inverted", () => {
    expect(occurrencesBetween("2026-01-01", 1, "month", "2026-05-01", "2026-03-01")).toEqual([]);
  });

  it("does not walk the years between an old start date and the range", () => {
    // A 1990 start must cost the same as a recent one: the first index is computed,
    // not stepped to. Twelve monthly dates, and no timeout.
    const dates = occurrencesBetween("1990-01-10", 1, "month", "2026-01-01", "2026-12-31");
    expect(dates).toHaveLength(12);
    expect(dates[0]).toBe("2026-01-10");
    expect(dates[11]).toBe("2026-12-10");
  });

  it("refuses a nonsensical interval rather than looping", () => {
    expect(occurrencesBetween("2026-01-01", 0, "month", "2026-01-01", "2026-12-31")).toEqual([]);
    expect(occurrencesBetween("2026-01-01", 1.5, "month", "2026-01-01", "2026-12-31")).toEqual([]);
  });
});

describe("shiftMonths", () => {
  it("moves back whole months and clamps the day", () => {
    expect(shiftMonths("2026-09-06", -12)).toBe("2025-09-06");
    expect(shiftMonths("2026-03-31", -1)).toBe("2026-02-28");
  });
});
