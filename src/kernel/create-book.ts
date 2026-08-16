import { isCurrencyCode } from "./currency";
import { err, ok, type Result } from "./result";
import type { Book, CurrencyCode } from "./types";

export function createBook(input: {
  name: string;
  homeCurrency: CurrencyCode;
}): Result<Book> {
  const name = input.name.trim();
  if (name.length === 0) {
    return err("BOOK_NAME_INVALID", "Book name must be non-empty");
  }
  if (!isCurrencyCode(input.homeCurrency)) {
    return err("INVALID_CURRENCY_CODE", `Invalid currency ${input.homeCurrency}`, {
      currency: input.homeCurrency,
    });
  }
  return ok({
    schemaVersion: 1,
    name,
    homeCurrency: input.homeCurrency,
    accounts: [],
    journal: [],
    budgets: [],
  });
}
