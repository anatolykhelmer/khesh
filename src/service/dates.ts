/** Local calendar date YYYY-MM-DD. */
export function todayCalendarDate(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** {year, month} for "now" (local time); month is 1-12. */
export function currentYearMonth(now = new Date()): { year: number; month: number } {
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

/** First and last calendar-date of the given month, as YYYY-MM-DD strings. */
export function monthRange(year: number, month: number): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate();
  return {
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(lastDay)}`,
  };
}

export type YearMonth = { year: number; month: number };

/** Move a year/month by whole months, rolling over year boundaries. */
export function shiftYearMonth(period: YearMonth, delta: number): YearMonth {
  let { year, month } = period;
  month += delta;
  while (month < 1) {
    month += 12;
    year -= 1;
  }
  while (month > 12) {
    month -= 12;
    year += 1;
  }
  return { year, month };
}

/** "YYYY-MM", the form used in the journal's query string. */
export function formatYearMonth(period: YearMonth): string {
  return `${period.year}-${String(period.month).padStart(2, "0")}`;
}

/** First and last calendar-date of the given year, as YYYY-MM-DD strings. */
export function yearRange(year: number): { from: string; to: string } {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}
