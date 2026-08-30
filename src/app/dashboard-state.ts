import { descendants } from "../kernel";
import type { Book, BudgetReport, CurrencyCode, MinorUnits, PeriodTotals } from "../kernel";

/**
 * What the Dashboard shows above the fold. The screen renders one of these three and
 * nothing else, so every branch the old screen carried inline lives here under test.
 */
export type HeroState =
  | { kind: "budgeted"; spent: MinorUnits; limit: MinorUnits; pct: number; over: boolean }
  | { kind: "unbudgeted"; spent: MinorUnits }
  | { kind: "empty" };

/**
 * The hero speaks for the home currency alone. The book stores FX per entry line and
 * carries no rate table, so there is no honest way to add other currencies into one
 * figure; they keep their own sections further down the screen.
 */
export function heroState(book: Book, totals: PeriodTotals, report: BudgetReport): HeroState {
  // "Empty" is a property of the book, not of the month. Deciding it from zero totals
  // would greet a two-year-old book with a first-run invitation the moment the user
  // paged forward into an empty month.
  if (book.journal.length === 0) return { kind: "empty" };

  const spent = (totals[book.homeCurrency]?.expense ?? 0) as MinorUnits;
  const limit = homeLimit(book, report, book.homeCurrency);
  if (limit === null) return { kind: "unbudgeted", spent };

  return { kind: "budgeted", spent, limit, pct: percentOf(spent, limit), over: spent > limit };
}

/**
 * The sum of the outermost limits in the given currency, or null when there are none.
 *
 * A limit can sit on a group and on one of its own descendants at the same time, and
 * `budgetReport` returns a row for each. Adding both would inflate the denominator by
 * the nested limit, so nested rows are dropped.
 */
function homeLimit(
  book: Book,
  report: BudgetReport,
  currency: CurrencyCode,
): MinorUnits | null {
  const rows = report.rows.filter((row) => row.currency === currency);
  if (rows.length === 0) return null;

  const nested = new Set<string>();
  for (const row of rows) {
    for (const child of descendants(book, row.accountId)) nested.add(child.id);
  }

  let total = 0;
  for (const row of rows) {
    if (nested.has(row.accountId)) continue;
    total += row.limit;
  }
  return total as MinorUnits;
}

/**
 * Clamped to 0–100 so the bar can never overflow its track. The overrun is not lost —
 * `over` carries it, and the screen paints a full bar in the overspend colour.
 * A zero limit reads as fully consumed rather than as NaN.
 */
function percentOf(spent: MinorUnits, limit: MinorUnits): number {
  if (limit <= 0) return 100;
  return Math.min(100, Math.round((spent / limit) * 100));
}
