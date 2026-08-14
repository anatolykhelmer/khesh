import { findAccount } from "./book-utils";
import { err, ok, type Result } from "./result";
import type { Book, FxSpec, JournalEntryKind, MinorUnits, PostingSide } from "./types";

export type PostingInput = {
  accountId: string;
  side: PostingSide;
  amount: MinorUnits;
};

export function currencyNet(
  book: Book,
  postings: PostingInput[],
  currency: string,
): number {
  let debit = 0;
  let credit = 0;
  for (const posting of postings) {
    const account = findAccount(book, posting.accountId);
    if (!account || account.currency !== currency) continue;
    if (posting.side === "debit") debit += posting.amount;
    else credit += posting.amount;
  }
  return Math.abs(debit - credit);
}

export function validatePostings(
  book: Book,
  postings: PostingInput[],
  kind: JournalEntryKind,
  fx: FxSpec | undefined,
): Result<true> {
  if (postings.length < 2) {
    return err("ENTRY_TOO_FEW_POSTINGS", "An entry must have at least 2 postings");
  }
  const distinct = new Set(postings.map((posting) => posting.accountId));
  if (distinct.size < 2) {
    return err("ENTRY_TOO_FEW_ACCOUNTS", "An entry must post to at least 2 distinct accounts");
  }

  const currencies = new Set<string>();
  for (const posting of postings) {
    if (!Number.isInteger(posting.amount) || posting.amount <= 0 || !Number.isFinite(posting.amount)) {
      return err("ENTRY_AMOUNT_INVALID", "Posting amount must be a positive integer", {
        amount: posting.amount,
      });
    }
    const account = findAccount(book, posting.accountId);
    if (!account) {
      return err("ACCOUNT_NOT_FOUND", "Account not found", { accountId: posting.accountId });
    }
    if (account.isPlaceholder) {
      return err("ACCOUNT_IS_PLACEHOLDER", "Cannot post to a placeholder account", {
        accountId: posting.accountId,
      });
    }
    currencies.add(account.currency);
  }

  if (kind === "opening" && currencies.size !== 1) {
    return err(
      "ENTRY_OPENING_MUST_BE_SINGLE_CURRENCY",
      "Opening entries must be single-currency",
    );
  }

  if (fx !== undefined && currencies.size !== 2) {
    return err("ENTRY_FX_CURRENCY_COUNT", "fx requires exactly two currencies", {
      currencies: [...currencies],
    });
  }

  if (currencies.size === 1) {
    let debit = 0;
    let credit = 0;
    for (const posting of postings) {
      if (posting.side === "debit") debit += posting.amount;
      else credit += posting.amount;
    }
    if (debit !== credit) {
      return err("ENTRY_UNBALANCED", "Debits must equal credits", { debit, credit });
    }
    return ok(true);
  }

  if (currencies.size === 2) {
    if (fx) {
      const fxSet = new Set([fx.baseCurrency, fx.quoteCurrency]);
      if (
        fxSet.size !== 2 ||
        ![...currencies].every((currency) => fxSet.has(currency))
      ) {
        return err("ENTRY_FX_RATE_MISMATCH", "fx currencies must match posting currencies");
      }
      if (
        !Number.isInteger(fx.baseAmount) ||
        fx.baseAmount <= 0 ||
        !Number.isInteger(fx.quoteAmount) ||
        fx.quoteAmount <= 0
      ) {
        return err("ENTRY_FX_RATE_MISMATCH", "fx amounts must be positive integers");
      }
      if (
        fx.baseAmount !== currencyNet(book, postings, fx.baseCurrency) ||
        fx.quoteAmount !== currencyNet(book, postings, fx.quoteCurrency)
      ) {
        return err("ENTRY_FX_RATE_MISMATCH", "fx amounts must match currency nets");
      }
    }
    return ok(true);
  }

  return err("ENTRY_FX_CURRENCY_COUNT", "Entry must use 1 or 2 currencies", {
    count: currencies.size,
  });
}
