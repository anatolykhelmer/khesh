import {
  accountPath,
  isOpeningBalancesGroupId,
  isOpeningBalancesLeafId,
  type Book,
  type FxSpec,
} from "../kernel";
import { minorToMajor } from "../service/money";
import { currencySymbol } from "./currencies";
import i18n from "./i18n";

export function formatMinor(minor: number, currency: string): string {
  return `${minorToMajor(minor)} ${currencySymbol(currency)}`;
}

/**
 * Display-only rate implied by the two amounts on an entry. Never stored or used
 * to compute an amount — the amounts the user typed are the source of truth.
 */
export function formatRate(fx: FxSpec): string {
  const rate = fx.quoteAmount / fx.baseAmount;
  return `1 ${fx.baseCurrency} = ${rate.toFixed(4)} ${fx.quoteCurrency}`;
}

/**
 * Full path, e.g. "Assets:Banks:Checking". Names are unique only among siblings, so
 * anywhere an account is shown out of tree context it needs its path to stay unambiguous.
 */
export function accountPathLabel(book: Book, id: string): string {
  if (isOpeningBalancesGroupId(id)) {
    return i18n.t("accounts.openingBalances");
  }
  if (isOpeningBalancesLeafId(id)) {
    const account = book.accounts.find((a) => a.id === id);
    const label = account ? currencySymbol(account.currency) : id;
    return `${i18n.t("accounts.openingBalances")}:${label}`;
  }
  const path = accountPath(book, id);
  return path.ok ? path.value : id;
}

const MONTH_KEYS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
] as const;

/** Localized month name; month is 1-12. */
export function monthLabel(month: number): string {
  return i18n.t(`months.${MONTH_KEYS[month - 1]}`);
}

/** Locale-formatted calendar date from a "YYYY-MM-DD" string. Appending a local
 * midnight time avoids `new Date("YYYY-MM-DD")`'s UTC-midnight parsing, which can
 * shift the displayed day backward in negative-UTC-offset timezones. */
export function formatDate(isoDate: string): string {
  return new Intl.DateTimeFormat(i18n.language).format(new Date(`${isoDate}T00:00:00`));
}
