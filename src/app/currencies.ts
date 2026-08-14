import type { CurrencyCode } from "../kernel";

/** Currencies offered in the UI. All use 2 fraction digits. */
export const CURRENCIES: readonly CurrencyCode[] = ["ILS", "USD", "EUR"];

const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  ILS: "₪",
  USD: "$",
  EUR: "€",
};

export function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency as CurrencyCode] ?? currency;
}
