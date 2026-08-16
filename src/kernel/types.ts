export type CurrencyCode = string;
export type MinorUnits = number;
export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export type PostingSide = "debit" | "credit";
export type JournalEntryKind = "standard" | "opening";

export interface Book {
  schemaVersion: 1;
  name: string;
  homeCurrency: CurrencyCode;
  accounts: Account[];
  journal: JournalEntry[];
  budgets: Budget[];
}

export type BudgetPeriod = "month" | "year";

export interface Budget {
  accountId: string;
  period: BudgetPeriod;
  currency: CurrencyCode;
  limit: MinorUnits;
}

export interface Account {
  id: string;
  parentId: string | null;
  name: string;
  type: AccountType;
  currency: CurrencyCode;
  isPlaceholder: boolean;
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
