import type { AccountType } from "../kernel";
import { currentYearMonth, monthRange } from "../service/dates";
import { monthLabel } from "./format";

/**
 * Which number an account row shows. Assets and liabilities carry a running balance;
 * income and expenses show the current calendar month's turnover, because their
 * lifetime sum only grows and answers nothing. The rule is by type, not by root, so a
 * nested expense group resolves the same way its leaves do.
 */
export type AccountFigure =
  | { kind: "balance" }
  | { kind: "month"; year: number; month: number; range: { from: string; to: string } };

export function accountFigure(type: AccountType, now = new Date()): AccountFigure {
  if (type !== "income" && type !== "expense") return { kind: "balance" };
  const { year, month } = currentYearMonth(now);
  return { kind: "month", year, month, range: monthRange(year, month) };
}

/** "September 2026" — the same composition Statistics and Budget use for their headers. */
export function monthFigureLabel(figure: { year: number; month: number }): string {
  return `${monthLabel(figure.month)} ${figure.year}`;
}
