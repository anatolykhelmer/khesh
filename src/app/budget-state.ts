import type { BudgetPeriod } from "../kernel";
import {
  currentYearMonth,
  formatYearMonth,
  monthRange,
  shiftYearMonth,
  yearRange,
} from "../service/dates";

/**
 * The screen always carries both a year and a month: the URL holds only the one the
 * active period needs, and keeping the other lets the Month/Year toggle stay put.
 */
export type BudgetState = { period: BudgetPeriod; year: number; month: number };

const MONTH_PARAM = /^(\d{4})-(\d{2})$/;
const YEAR_PARAM = /^\d{4}$/;

export function parseBudgetState(params: URLSearchParams, now = new Date()): BudgetState {
  const current = currentYearMonth(now);
  if (params.get("period") === "year") {
    const raw = params.get("year") ?? "";
    const year = YEAR_PARAM.test(raw) ? Number(raw) : current.year;
    return { period: "year", year, month: current.month };
  }
  const match = MONTH_PARAM.exec(params.get("month") ?? "");
  if (!match) return { period: "month", year: current.year, month: current.month };
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    return { period: "month", year: current.year, month: current.month };
  }
  return { period: "month", year: Number(match[1]), month };
}

export function toBudgetParams(state: BudgetState): URLSearchParams {
  const params = new URLSearchParams();
  params.set("period", state.period);
  if (state.period === "year") params.set("year", String(state.year));
  else params.set("month", formatYearMonth({ year: state.year, month: state.month }));
  return params;
}

export function shiftBudgetState(state: BudgetState, delta: number): BudgetState {
  if (state.period === "year") return { ...state, year: state.year + delta };
  const next = shiftYearMonth({ year: state.year, month: state.month }, delta);
  return { period: "month", year: next.year, month: next.month };
}

export function setPeriodKind(
  state: BudgetState,
  period: BudgetPeriod,
  now = new Date(),
): BudgetState {
  if (period === state.period) return state;
  if (period === "year") return { ...state, period: "year" };
  return { period: "month", year: state.year, month: currentYearMonth(now).month };
}

export function budgetRange(state: BudgetState): { from: string; to: string } {
  return state.period === "year"
    ? yearRange(state.year)
    : monthRange(state.year, state.month);
}
