export type CurrencyCode = string;
export type MinorUnits = number;
export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export type PostingSide = "debit" | "credit";
export type JournalEntryKind = "standard" | "opening";

export type TombstoneKind = "account" | "entry" | "budget" | "recurrence";

export interface Tombstone {
  kind: TombstoneKind;
  /** account/entry/recurrence id; for budgets `${accountId}|${period}|${currency}`. */
  key: string;
  deletedAt: string;
  /** Full snapshot at deletion, so a merge can resurrect or compare the record. */
  record: Account | JournalEntry | Budget | Recurrence;
}

export interface Book {
  schemaVersion: 3;
  name: string;
  homeCurrency: CurrencyCode;
  metaUpdatedAt: string;
  accounts: Account[];
  journal: JournalEntry[];
  budgets: Budget[];
  recurrences: Recurrence[];
  tombstones: Tombstone[];
}

export type BudgetPeriod = "month" | "year";

export interface Budget {
  accountId: string;
  period: BudgetPeriod;
  currency: CurrencyCode;
  limit: MinorUnits;
  updatedAt: string;
}

export interface Account {
  id: string;
  parentId: string | null;
  name: string;
  type: AccountType;
  currency: CurrencyCode;
  isPlaceholder: boolean;
  updatedAt: string;
}

export interface FxSpec {
  baseCurrency: CurrencyCode;
  quoteCurrency: CurrencyCode;
  baseAmount: MinorUnits;
  quoteAmount: MinorUnits;
}

export interface Posting {
  accountId: string;
  side: PostingSide;
  amount: MinorUnits;
}

export interface JournalEntry {
  id: string;
  date: string;
  description: string;
  kind: JournalEntryKind;
  postings: Posting[];
  fx?: FxSpec;
  updatedAt: string;
}

export interface AccountNode extends Account {
  children: AccountNode[];
}

export type AccountBalance =
  | { kind: "leaf"; currency: CurrencyCode; amount: number }
  | { kind: "placeholder"; balances: Record<CurrencyCode, number> };

export interface TrialBalance {
  asOf: string | null;
  byCurrency: Record<
    CurrencyCode,
    {
      rows: Array<{
        accountId: string;
        debitTotal: MinorUnits;
        creditTotal: MinorUnits;
        signedBalance: number;
      }>;
      debitTotal: MinorUnits;
      creditTotal: MinorUnits;
    }
  >;
}

export type RecurrenceUnit = "week" | "month" | "year";

export interface RecurrenceLine {
  toAccountId: string;
  amount: MinorUnits;
}

/**
 * A repeating payment. The occurrences it implies are derived from `startDate`, `every`
 * and `unit` — never stored — and reach the journal only when the user confirms one.
 */
export interface Recurrence {
  id: string;
  /** Becomes the posted entry's description. */
  description: string;
  fromAccountId: string;
  /** At least one; every account involved shares one currency. */
  lines: RecurrenceLine[];
  /** Integer >= 1. */
  every: number;
  unit: RecurrenceUnit;
  /** YYYY-MM-DD; the first occurrence, and the anchor every later one is computed from. */
  startDate: string;
  /** YYYY-MM-DD, inclusive; null means open-ended. */
  endDate: string | null;
  /** YYYY-MM-DD the pause began, or null when the rule is live. */
  pausedAt: string | null;
  /** Occurrence dates the user dismissed outright. */
  skipped: string[];
  /** Occurrence dates hidden from the Dashboard card but still pending in the journal. */
  deferred: string[];
  updatedAt: string;
}
