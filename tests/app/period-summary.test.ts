import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUMMARY,
  SUMMARY_PRESETS,
  SUMMARY_PRESET_KEYS,
  isSummaryPreset,
  parseSummaryState,
  summaryBounds,
  summaryLabel,
  summaryMonthParam,
  toSummaryParams,
  type SummaryState,
} from "../../src/app/period-summary";
import en from "../../src/app/locales/en.json";

const MID_AUGUST = new Date(2026, 7, 16); // local time, the date account-figure.test uses
const MID_JANUARY = new Date(2027, 0, 10);

const CUSTOM: SummaryState = { preset: "custom", from: "2026-03-12", to: "2026-07-20" };

describe("parseSummaryState", () => {
  it("defaults to this month", () => {
    expect(parseSummaryState(new URLSearchParams())).toEqual({ preset: "this-month" });
    expect(DEFAULT_SUMMARY).toEqual({ preset: "this-month" });
  });

  it("round-trips every non-custom preset through toSummaryParams", () => {
    for (const preset of SUMMARY_PRESETS) {
      if (preset === "custom") continue;
      const state: SummaryState = { preset };
      expect(parseSummaryState(toSummaryParams(state))).toEqual(state);
    }
  });

  it("writes nothing for the default so the URL stays clean", () => {
    expect(toSummaryParams({ preset: "this-month" }).toString()).toBe("");
    expect(toSummaryParams({ preset: "last-year" }).toString()).toBe("period=last-year");
  });

  it("falls back to this month on an unknown preset", () => {
    for (const raw of ["period=nonsense", "period=", "period=month"]) {
      expect(parseSummaryState(new URLSearchParams(raw))).toEqual({ preset: "this-month" });
    }
  });

  it("keeps a complete custom range and round-trips it", () => {
    const params = new URLSearchParams("period=custom&from=2026-03-12&to=2026-07-20");
    expect(parseSummaryState(params)).toEqual(CUSTOM);
    expect(toSummaryParams(CUSTOM).toString()).toBe("period=custom&from=2026-03-12&to=2026-07-20");
  });

  it("keeps a half-typed custom range with the missing date as an empty string", () => {
    expect(parseSummaryState(new URLSearchParams("period=custom&from=2026-03-12"))).toEqual({
      preset: "custom",
      from: "2026-03-12",
      to: "",
    });
    expect(parseSummaryState(new URLSearchParams("period=custom"))).toEqual({
      preset: "custom",
      from: "",
      to: "",
    });
    expect(toSummaryParams({ preset: "custom", from: "2026-03-12", to: "" }).toString()).toBe(
      "period=custom&from=2026-03-12",
    );
  });

  it("keeps a malformed custom date as-is instead of falling back", () => {
    expect(parseSummaryState(new URLSearchParams("period=custom&from=2026-13-01&to=2026-07-20"))).toEqual(
      { preset: "custom", from: "2026-13-01", to: "2026-07-20" },
    );
    expect(parseSummaryState(new URLSearchParams("period=custom&from=2026-03-12&to=nope"))).toEqual({
      preset: "custom",
      from: "2026-03-12",
      to: "nope",
    });
  });

  it("keeps a partially typed year instead of resetting the picker", () => {
    const state = parseSummaryState(new URLSearchParams("period=custom&from=0002-12-03&to=2026-12-20"));
    expect(state).toEqual({ preset: "custom", from: "0002-12-03", to: "2026-12-20" });
    expect(summaryBounds(state)).toBeNull();
  });

  it("isSummaryPreset accepts exactly the preset list", () => {
    for (const preset of SUMMARY_PRESETS) expect(isSummaryPreset(preset)).toBe(true);
    expect(isSummaryPreset("month")).toBe(false);
    expect(isSummaryPreset("")).toBe(false);
  });
});

describe("summaryBounds", () => {
  it("resolves each preset against now", () => {
    expect(summaryBounds({ preset: "this-month" }, MID_AUGUST)).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(summaryBounds({ preset: "last-month" }, MID_AUGUST)).toEqual({
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(summaryBounds({ preset: "this-year" }, MID_AUGUST)).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(summaryBounds({ preset: "last-year" }, MID_AUGUST)).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
    expect(summaryBounds({ preset: "all" }, MID_AUGUST)).toEqual({});
  });

  it("rolls last month into the previous year in January", () => {
    expect(summaryBounds({ preset: "last-month" }, MID_JANUARY)).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
  });

  it("passes a complete, ordered custom range through", () => {
    expect(summaryBounds(CUSTOM, MID_AUGUST)).toEqual({ from: "2026-03-12", to: "2026-07-20" });
    expect(
      summaryBounds({ preset: "custom", from: "2026-03-12", to: "2026-03-12" }, MID_AUGUST),
    ).toEqual({ from: "2026-03-12", to: "2026-03-12" });
  });

  it("is null while a custom range is incomplete or inverted", () => {
    expect(summaryBounds({ preset: "custom", from: "", to: "" }, MID_AUGUST)).toBeNull();
    expect(summaryBounds({ preset: "custom", from: "2026-03-12", to: "" }, MID_AUGUST)).toBeNull();
    expect(summaryBounds({ preset: "custom", from: "", to: "2026-07-20" }, MID_AUGUST)).toBeNull();
    expect(
      summaryBounds({ preset: "custom", from: "2026-07-20", to: "2026-03-12" }, MID_AUGUST),
    ).toBeNull();
  });

  it("is null while a year is still being typed, even once it is a valid date", () => {
    // Chrome emits 0002 → 0020 → 0202 → 2026 for a typed year; the middle two pass
    // isCalendarDate, so the gate has to be on plausibility, not validity.
    for (const from of ["0202-12-03", "0199-12-03", "0999-12-31"]) {
      expect(summaryBounds({ preset: "custom", from, to: "2026-12-20" }, MID_AUGUST)).toBeNull();
      expect(summaryBounds({ preset: "custom", from: "2026-01-01", to: from }, MID_AUGUST)).toBeNull();
    }
    expect(
      summaryBounds({ preset: "custom", from: "1000-01-01", to: "2026-12-20" }, MID_AUGUST),
    ).toEqual({ from: "1000-01-01", to: "2026-12-20" });
  });
});

describe("summaryLabel", () => {
  it("names month and year presets the way the screens already do", () => {
    expect(summaryLabel({ preset: "this-month" }, MID_AUGUST)).toBe("August 2026");
    expect(summaryLabel({ preset: "last-month" }, MID_AUGUST)).toBe("July 2026");
    expect(summaryLabel({ preset: "this-year" }, MID_AUGUST)).toBe("2026");
    expect(summaryLabel({ preset: "last-year" }, MID_AUGUST)).toBe("2025");
  });

  it("uses the locale strings for all time and for an incomplete custom range", () => {
    expect(summaryLabel({ preset: "all" }, MID_AUGUST)).toBe(en.periodSummary.all);
    expect(summaryLabel({ preset: "custom", from: "2026-03-12", to: "" }, MID_AUGUST)).toBe(
      en.periodSummary.custom,
    );
  });

  it("shows both dates of a complete custom range", () => {
    const label = summaryLabel(CUSTOM, MID_AUGUST);
    expect(label).toContain("3/12/2026");
    expect(label).toContain("7/20/2026");
  });

  it("uses the locale string for a complete but inverted custom range", () => {
    expect(
      summaryLabel({ preset: "custom", from: "2026-07-20", to: "2026-03-12" }, MID_AUGUST),
    ).toBe(en.periodSummary.custom);
  });
});

describe("summaryMonthParam", () => {
  it("passes the month for the two month presets and all for everything else", () => {
    expect(summaryMonthParam({ preset: "this-month" }, MID_AUGUST)).toBe("2026-08");
    expect(summaryMonthParam({ preset: "last-month" }, MID_AUGUST)).toBe("2026-07");
    expect(summaryMonthParam({ preset: "last-month" }, MID_JANUARY)).toBe("2026-12");
    expect(summaryMonthParam({ preset: "this-year" }, MID_AUGUST)).toBe("all");
    expect(summaryMonthParam({ preset: "all" }, MID_AUGUST)).toBe("all");
    expect(
      summaryMonthParam({ preset: "custom", from: "2026-08-01", to: "2026-08-31" }, MID_AUGUST),
    ).toBe("all");
  });
});

describe("SUMMARY_PRESET_KEYS", () => {
  it("names a locale key for every preset", () => {
    for (const preset of SUMMARY_PRESETS) {
      const key = SUMMARY_PRESET_KEYS[preset].replace(/^periodSummary\./, "");
      expect(en.periodSummary).toHaveProperty(key);
    }
  });
});
