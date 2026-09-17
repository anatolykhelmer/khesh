import type { Book, CurrencyCode, PeriodBreakdown, PeriodSlice } from "../kernel";
import { formatYearMonth, parseYearMonthParam, type YearMonth } from "../service/dates";

export type StatsState = {
  period: YearMonth;
  accountId: string | null;
  currency: CurrencyCode | null;
};

export function parseStatsState(
  params: URLSearchParams,
  book: Book,
  now = new Date(),
): StatsState {
  return {
    period: parseYearMonthParam(params.get("month"), now),
    accountId: parseAccountId(params.get("account"), book),
    currency: parseCurrency(params.get("currency")),
  };
}

export function expenseRootId(book: Book): string | null {
  const roots = book.accounts.filter((a) => a.type === "expense" && a.parentId === null);
  if (roots.length === 0) return null;
  const named = roots.find((a) => a.name === "Expenses");
  if (named) return named.id;
  return [...roots].sort((a, b) => a.name.localeCompare(b.name))[0].id;
}

export function toStatsParams(state: StatsState): URLSearchParams {
  const params = new URLSearchParams();
  params.set("month", formatYearMonth(state.period));
  if (state.accountId) params.set("account", state.accountId);
  if (state.currency) params.set("currency", state.currency);
  return params;
}

/** What the statistics screen shows for one breakdown, once the rendering is left out. */
export type StatsView = {
  /** The children a pie can be drawn from, in the order the breakdown listed them. */
  positive: PeriodSlice[];
  showPie: boolean;
  showLegend: boolean;
  showTotal: boolean;
  /** The colour class for a legend row: a bare swatch for a child no slice was drawn for. */
  swatchClass: (childId: string) => string;
};

/**
 * The show-and-hide rules of the statistics screen.
 *
 * A refund can push a child, or the whole period, below zero, and a pie has nothing to say
 * about a negative share: it is drawn from the positive children only, and only when there
 * are some and the period as a whole is still spending. The legend is not a pie caption —
 * it lists every child, refunds included, so a month whose total nets to zero still shows
 * where the money went. "No expenses this month" is therefore for a period with no children
 * and no total at all, not merely for one that cancels out.
 */
export function statsView(
  breakdown: Pick<PeriodBreakdown, "isGroup" | "total" | "children">,
): StatsView {
  const positive = breakdown.children.filter((child) => child.amount > 0);
  const showLegend = breakdown.children.length > 0;
  return {
    positive,
    showPie: breakdown.isGroup && positive.length > 0 && breakdown.total > 0,
    showLegend,
    showTotal: showLegend || breakdown.total !== 0,
    swatchClass: (childId: string) => {
      const slot = positive.findIndex((slice) => slice.id === childId);
      return slot === -1 ? "swatch" : `swatch cat-${slot % 6}`;
    },
  };
}

function parseAccountId(raw: string | null, book: Book): string | null {
  if (raw === null) return null;
  const account = book.accounts.find((a) => a.id === raw);
  if (!account || account.type !== "expense") return null;
  return raw;
}

function parseCurrency(raw: string | null): CurrencyCode | null {
  if (raw === null || raw === "") return null;
  return raw;
}
