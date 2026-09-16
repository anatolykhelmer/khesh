import { isCalendarDate, type DateBounds } from "../kernel";
import {
  currentYearMonth,
  formatYearMonth,
  monthRange,
  shiftYearMonth,
  yearRange,
  type YearMonth,
} from "../service/dates";
import { formatDate, monthLabel } from "./format";
import i18n from "./i18n";

/**
 * The account page's period picker. Modelled on `journal-filter.ts`: state lives in the
 * query string so Back from Entries lands on the same view, and anything unusable in the
 * URL falls back to the default instead of surfacing an error — a bad URL is not a user
 * mistake.
 */
export const SUMMARY_PRESETS = [
  "this-month",
  "last-month",
  "this-year",
  "last-year",
  "all",
  "custom",
] as const;

export type SummaryPreset = (typeof SUMMARY_PRESETS)[number];

export type SummaryState =
  | { preset: Exclude<SummaryPreset, "custom"> }
  /** Raw input values; either may be "" while the person is still typing. */
  | { preset: "custom"; from: string; to: string };

export const DEFAULT_SUMMARY: SummaryState = { preset: "this-month" };

export const SUMMARY_PRESET_KEYS: Record<SummaryPreset, string> = {
  "this-month": "periodSummary.thisMonth",
  "last-month": "periodSummary.lastMonth",
  "this-year": "periodSummary.thisYear",
  "last-year": "periodSummary.lastYear",
  all: "periodSummary.all",
  custom: "periodSummary.custom",
};

export function isSummaryPreset(value: string): value is SummaryPreset {
  return (SUMMARY_PRESETS as readonly string[]).includes(value);
}

/**
 * A custom-range field is kept as the raw string the URL carries — "" when absent,
 * otherwise whatever was typed, valid, partial or malformed. This parser only decides
 * what to keep; `summaryBounds` decides what is complete enough to act on. Discarding
 * anything short of a full calendar date would reset the picker on every keystroke: a
 * keyboard-typed `<input type="date">` fires "0002-12-03" on the way to "2026-12-03".
 */
export function parseSummaryState(params: URLSearchParams): SummaryState {
  const preset = params.get("period");
  if (preset === null || !isSummaryPreset(preset)) return DEFAULT_SUMMARY;
  if (preset !== "custom") return { preset };
  return { preset: "custom", from: params.get("from") ?? "", to: params.get("to") ?? "" };
}

export function toSummaryParams(state: SummaryState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.preset === "this-month") return params;
  params.set("period", state.preset);
  if (state.preset === "custom") {
    if (state.from) params.set("from", state.from);
    if (state.to) params.set("to", state.to);
  }
  return params;
}

function presetMonth(preset: "this-month" | "last-month", now: Date): YearMonth {
  const current = currentYearMonth(now);
  return preset === "this-month" ? current : shiftYearMonth(current, -1);
}

/** Bounds for `turnoverInRange`, or null while a custom range is incomplete or inverted. */
export function summaryBounds(state: SummaryState, now = new Date()): DateBounds | null {
  switch (state.preset) {
    case "this-month":
    case "last-month": {
      const { year, month } = presetMonth(state.preset, now);
      return monthRange(year, month);
    }
    case "this-year":
      return yearRange(now.getFullYear());
    case "last-year":
      return yearRange(now.getFullYear() - 1);
    case "all":
      return {};
    case "custom":
      if (!isSettledDate(state.from) || !isSettledDate(state.to)) return null;
      return state.from <= state.to ? { from: state.from, to: state.to } : null;
  }
}

/**
 * A calendar date whose year has all four digits typed. Chrome emits 0002 → 0020 →
 * 0202 → 2026 while a year is keyed in, and the middle two are valid calendar dates,
 * so validity alone would run the query against year 202 on the penultimate keystroke.
 * No ledger predates year 1000; a lower year is still being typed.
 */
function isSettledDate(value: string): boolean {
  return isCalendarDate(value) && Number(value.slice(0, 4)) >= 1000;
}

/** "August 2026", "2026", "All time", "3/12/2026 – 7/20/2026". */
export function summaryLabel(state: SummaryState, now = new Date()): string {
  switch (state.preset) {
    case "this-month":
    case "last-month": {
      const { year, month } = presetMonth(state.preset, now);
      return `${monthLabel(month)} ${year}`;
    }
    case "this-year":
      return String(now.getFullYear());
    case "last-year":
      return String(now.getFullYear() - 1);
    case "all":
      return i18n.t(SUMMARY_PRESET_KEYS.all);
    case "custom":
      return summaryBounds(state, now)
        ? `${formatDate(state.from)} – ${formatDate(state.to)}`
        : i18n.t(SUMMARY_PRESET_KEYS.custom);
  }
}

/**
 * The `month` value the Entries link passes to the Journal: the month for the two month
 * presets, `all` for everything else. A custom range that happens to be exactly one
 * calendar month is deliberately not detected — pick the month preset for that.
 */
export function summaryMonthParam(state: SummaryState, now = new Date()): string {
  if (state.preset === "this-month" || state.preset === "last-month") {
    return formatYearMonth(presetMonth(state.preset, now));
  }
  return "all";
}
