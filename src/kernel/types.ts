export type CurrencyCode = string;
export type MinorUnits = number;
export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export type PostingSide = "debit" | "credit";
export type JournalEntryKind = "standard" | "opening";

export type TombstoneKind = "account" | "entry" | "budget";

export interface Tombstone {
  kind: TombstoneKind;
  /** account/entry id; for budgets `${accountId}|${period}|${currency}`. */
  key: string;
  deletedAt: string;
  /** Full snapshot at deletion, so a merge can resurrect or compare the record. */
  record: Account | JournalEntry | Budget;
}

export interface Book {
  schemaVersion: 2;
  name: string;
  homeCurrency: CurrencyCode;
  metaUpdatedAt: string;
  accounts: Account[];
  journal: JournalEntry[];
  budgets: Budget[];
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
