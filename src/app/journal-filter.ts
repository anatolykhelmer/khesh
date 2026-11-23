import type { Book } from "../kernel";
import {
  currentYearMonth,
  formatYearMonth,
  monthRange,
  parseYearMonthParam,
  type YearMonth,
} from "../service/dates";

export type JournalFilterState = {
  /** null means all time. */
  period: YearMonth | null;
  accountId: string | null;
};

/**
 * Read filter state out of the query string. Anything unusable falls back to the
 * default rather than surfacing an error: a bad URL is not a user mistake, and a
 * stale account id would otherwise blank the screen with ACCOUNT_NOT_FOUND.
 */
export function parseJournalFilter(
  params: URLSearchParams,
  book: Book,
  now = new Date(),
): JournalFilterState {
  return {
    period: parsePeriod(params.get("month"), now),
    accountId: parseAccountId(params.get("account"), book),
  };
}

function parsePeriod(raw: string | null, now: Date): YearMonth | null {
  if (raw === "all") return null;
  return parseYearMonthParam(raw, now);
}

function parseAccountId(raw: string | null, book: Book): string | null {
  if (raw === null) return null;
  return book.accounts.some((a) => a.id === raw) ? raw : null;
}

/**
 * Whether the query string chooses the view itself. Either parameter, with any value,
 * counts: a bare /journal is the only case that falls back to the remembered view.
 */
export function hasExplicitJournalView(params: URLSearchParams): boolean {
  return params.has("month") || params.has("account");
}

/**
 * The query string for a parsed filter. The current month is left out, so the default
 * view is a bare query string; whatever was unusable in the source (a broken month, an
 * account the book lacks) is already gone from `state` and so stays out of the URL.
 */
export function toJournalParams(state: JournalFilterState, now = new Date()): URLSearchParams {
  const params = new URLSearchParams();
  if (state.period === null) {
    params.set("month", "all");
  } else {
    const current = currentYearMonth(now);
    const isCurrent = state.period.year === current.year && state.period.month === current.month;
    if (!isCurrent) params.set("month", formatYearMonth(state.period));
  }
  if (state.accountId !== null) params.set("account", state.accountId);
  return params;
}

/** Build the argument for `app.listJournal`. */
export function toListJournalFilter(state: JournalFilterState): {
  from?: string;
  to?: string;
  accountId?: string;
} {
  const filter: { from?: string; to?: string; accountId?: string } = {};
  if (state.period) {
    const range = monthRange(state.period.year, state.period.month);
    filter.from = range.from;
    filter.to = range.to;
  }
  if (state.accountId) filter.accountId = state.accountId;
  return filter;
}

/** Whether the state matches what an unparameterised /journal shows. */
export function isDefaultFilter(state: JournalFilterState, now = new Date()): boolean {
  if (state.accountId !== null || state.period === null) return false;
  const current = currentYearMonth(now);
  return state.period.year === current.year && state.period.month === current.month;
}
