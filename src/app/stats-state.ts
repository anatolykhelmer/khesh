import type { Book, CurrencyCode } from "../kernel";
import { currentYearMonth, formatYearMonth, type YearMonth } from "../service/dates";

export type StatsState = {
  period: YearMonth;
  accountId: string | null;
  currency: CurrencyCode | null;
};

const MONTH_PARAM = /^(\d{4})-(\d{2})$/;

export function parseStatsState(
  params: URLSearchParams,
  book: Book,
  now = new Date(),
): StatsState {
  return {
    period: parsePeriod(params.get("month"), now),
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

function parsePeriod(raw: string | null, now: Date): YearMonth {
  const match = raw === null ? null : MONTH_PARAM.exec(raw);
  if (!match) return currentYearMonth(now);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return currentYearMonth(now);
  return { year: Number(match[1]), month };
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
