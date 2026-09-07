import { isCalendarDate } from "./dates";
import type { RecurrenceUnit } from "./types";

const DAY_MS = 86_400_000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function parts(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

function toUtcMs(date: string): number {
  const { year, month, day } = parts(date);
  return Date.UTC(year, month - 1, day);
}

function fromUtcMs(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${pad2(d.getUTCMonth() + 1)}-${pad2(
    d.getUTCDate(),
  )}`;
}

/** Days in a 1-based (year, month). `Date.UTC`'s month is 0-based, so day 0 of `month` is
 * the last day of the month before it — which is the month asked for. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A calendar month index: year * 12 + (month - 1). Makes month arithmetic a plain add. */
function monthIndex(date: string): number {
  const { year, month } = parts(date);
  return year * 12 + (month - 1);
}

function fromMonthIndex(index: number, day: number): string {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(
    Math.min(day, daysInMonth(year, month)),
  )}`;
}

/** Move a date by whole months, clamping the day to the target month's length. */
export function shiftMonths(date: string, delta: number): string {
  return fromMonthIndex(monthIndex(date) + delta, parts(date).day);
}

/**
 * The k-th occurrence of a schedule; k = 0 is `startDate` itself. Negative k walks
 * backwards, which is how the window start is derived.
 *
 * Month and year steps are computed from `startDate` every time, never from the previous
 * occurrence. Folding the clamp forward would pin a rule that starts on the 31st to the
 * 28th for the rest of its life after a single February.
 */
export function occurrenceDate(
  startDate: string,
  every: number,
  unit: RecurrenceUnit,
  k: number,
): string {
  if (unit === "week") {
    return fromUtcMs(toUtcMs(startDate) + k * every * 7 * DAY_MS);
  }
  const months = unit === "month" ? every * k : every * k * 12;
  return fromMonthIndex(monthIndex(startDate) + months, parts(startDate).day);
}

/** A cheap lower bound for the first index at or after `from`; the caller corrects it. */
function estimateIndex(
  startDate: string,
  every: number,
  unit: RecurrenceUnit,
  from: string,
): number {
  if (unit === "week") {
    const days = (toUtcMs(from) - toUtcMs(startDate)) / DAY_MS;
    return Math.floor(days / (7 * every));
  }
  const months = monthIndex(from) - monthIndex(startDate);
  const steps = unit === "month" ? months : months / 12;
  return Math.floor(steps / every);
}

/**
 * Every occurrence date within `[from, to]`, ascending.
 *
 * The first index is computed arithmetically and then nudged by at most a step in each
 * direction — the day clamp can move a date earlier inside its month, so the estimate is a
 * bound, not an answer. Stepping from `startDate` instead would make a rule created with an
 * old start date cost hundreds of iterations on every render.
 */
export function occurrencesBetween(
  startDate: string,
  every: number,
  unit: RecurrenceUnit,
  from: string,
  to: string,
): string[] {
  if (!Number.isInteger(every) || every < 1) return [];
  if (!isCalendarDate(startDate) || !isCalendarDate(from) || !isCalendarDate(to)) return [];
  if (to < from) return [];

  const lower = from > startDate ? from : startDate;
  let k = Math.max(0, estimateIndex(startDate, every, unit, lower));
  while (k > 0 && occurrenceDate(startDate, every, unit, k - 1) >= lower) k -= 1;
  while (occurrenceDate(startDate, every, unit, k) < lower) k += 1;

  const dates: string[] = [];
  for (;;) {
    const date = occurrenceDate(startDate, every, unit, k);
    if (date > to) break;
    dates.push(date);
    k += 1;
  }
  return dates;
}
