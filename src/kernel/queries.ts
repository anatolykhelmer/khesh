import { findAccount } from "./book-utils";
import { isCalendarDate } from "./dates";
import { err, ok, type Result } from "./result";
import type {
  Account,
  AccountBalance,
  AccountNode,
  AccountType,
  Book,
  CurrencyCode,
  MinorUnits,
  TrialBalance,
} from "./types";

function signedAmount(type: AccountType, debit: number, credit: number): number {
  const raw = debit - credit;
  return type === "asset" || type === "expense" ? raw : -raw;
}

function entryIncluded(date: string, asOf: string | undefined): boolean {
  if (!asOf) return true;
  return date <= asOf;
}

function leafTotals(
  book: Book,
  accountId: string,
  asOf?: string,
): { debit: number; credit: number } {
  let debit = 0;
  let credit = 0;
  for (const entry of book.journal) {
    if (!entryIncluded(entry.date, asOf)) continue;
    for (const posting of entry.postings) {
      if (posting.accountId !== accountId) continue;
      if (posting.side === "debit") debit += posting.amount;
      else credit += posting.amount;
    }
  }
  return { debit, credit };
}

function descendants(book: Book, rootId: string): Account[] {
  const result: Account[] = [];
  const walk = (parentId: string) => {
    for (const account of book.accounts) {
      if (account.parentId !== parentId) continue;
      result.push(account);
      walk(account.id);
    }
  };
  walk(rootId);
  return result;
}

export function accountPath(book: Book, id: string): Result<string> {
  const account = findAccount(book, id);
  if (!account) return err("ACCOUNT_NOT_FOUND", "Account not found", { id });
  const names: string[] = [];
  let current: Account | undefined = account;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parentId ? findAccount(book, current.parentId) : undefined;
  }
  return ok(names.join(":"));
}

export function chart(book: Book): Result<AccountNode[]> {
  const byParent = new Map<string | null, Account[]>();
  for (const account of book.accounts) {
    const list = byParent.get(account.parentId) ?? [];
    list.push(account);
    byParent.set(account.parentId, list);
  }
  const build = (parentId: string | null): AccountNode[] =>
    (byParent.get(parentId) ?? []).map((account) => ({
      ...account,
      children: build(account.id),
    }));
  return ok(build(null));
}

export function balance(book: Book, accountId: string): Result<AccountBalance> {
  return balanceAsOfInternal(book, accountId, undefined);
}

export function balanceAsOf(
  book: Book,
  accountId: string,
  asOf: string,
): Result<AccountBalance> {
  if (!isCalendarDate(asOf)) {
    return err("ENTRY_DATE_INVALID", `Invalid date ${asOf}`, { date: asOf });
  }
  return balanceAsOfInternal(book, accountId, asOf);
}

function balanceAsOfInternal(
  book: Book,
  accountId: string,
  asOf: string | undefined,
): Result<AccountBalance> {
  const account = findAccount(book, accountId);
  if (!account) return err("ACCOUNT_NOT_FOUND", "Account not found", { id: accountId });

  if (!account.isPlaceholder) {
    const { debit, credit } = leafTotals(book, accountId, asOf);
    return ok({
      kind: "leaf",
      currency: account.currency,
      amount: signedAmount(account.type, debit, credit),
    });
  }

  const balances: Record<CurrencyCode, number> = {};
  for (const child of descendants(book, accountId)) {
    if (child.isPlaceholder) continue;
    const { debit, credit } = leafTotals(book, child.id, asOf);
    const signed = signedAmount(child.type, debit, credit);
    if (signed === 0) continue;
    balances[child.currency] = (balances[child.currency] ?? 0) + signed;
  }
  return ok({ kind: "placeholder", balances });
}

export function trialBalance(book: Book, asOf?: string): Result<TrialBalance> {
  if (asOf !== undefined && !isCalendarDate(asOf)) {
    return err("ENTRY_DATE_INVALID", `Invalid date ${asOf}`, { date: asOf });
  }

  const byCurrency: TrialBalance["byCurrency"] = {};
  for (const account of book.accounts) {
    if (account.isPlaceholder) continue;
    const { debit, credit } = leafTotals(book, account.id, asOf);
    if (debit === 0 && credit === 0) continue;
    const bucket = byCurrency[account.currency] ?? {
      rows: [],
      debitTotal: 0,
      creditTotal: 0,
    };
    bucket.rows.push({
      accountId: account.id,
      debitTotal: debit as MinorUnits,
      creditTotal: credit as MinorUnits,
      signedBalance: signedAmount(account.type, debit, credit),
    });
    bucket.debitTotal = (bucket.debitTotal + debit) as MinorUnits;
    bucket.creditTotal = (bucket.creditTotal + credit) as MinorUnits;
    byCurrency[account.currency] = bucket;
  }

  return ok({ asOf: asOf ?? null, byCurrency });
}

function entryInRange(date: string, range: { from: string; to: string }): boolean {
  return date >= range.from && date <= range.to;
}

function periodSigned(
  book: Book,
  account: Account,
  range: { from: string; to: string },
): number {
  let debit = 0;
  let credit = 0;
  for (const entry of book.journal) {
    if (!entryInRange(entry.date, range)) continue;
    for (const posting of entry.postings) {
      if (posting.accountId !== account.id) continue;
      if (posting.side === "debit") debit += posting.amount;
      else credit += posting.amount;
    }
  }
  return signedAmount(account.type, debit, credit);
}

export type PeriodTotals = Record<CurrencyCode, { income: MinorUnits; expense: MinorUnits }>;

export function periodTotals(
  book: Book,
  range: { from: string; to: string },
): Result<PeriodTotals> {
  if (!isCalendarDate(range.from)) {
    return err("ENTRY_DATE_INVALID", `Invalid date ${range.from}`, { date: range.from });
  }
  if (!isCalendarDate(range.to)) {
    return err("ENTRY_DATE_INVALID", `Invalid date ${range.to}`, { date: range.to });
  }

  const totals: PeriodTotals = { [book.homeCurrency]: { income: 0, expense: 0 } };

  for (const account of book.accounts) {
    if (account.isPlaceholder) continue;
    if (account.type !== "income" && account.type !== "expense") continue;
    const bucket = (totals[account.currency] ??= { income: 0, expense: 0 });
    const signed = periodSigned(book, account, range);
    if (account.type === "income") bucket.income += signed;
    else bucket.expense += signed;
  }

  return ok(totals);
}

export type PeriodSlice = {
  id: string;
  name: string;
  isGroup: boolean;
  amount: MinorUnits;
};

export type PeriodBreakdown = {
  accountId: string;
  name: string;
  isGroup: boolean;
  currency: CurrencyCode;
  total: MinorUnits;
  children: PeriodSlice[];
  currencies: CurrencyCode[];
  ancestors: Array<{ id: string; name: string }>;
};

function subtreeAmount(
  book: Book,
  node: Account,
  currency: CurrencyCode,
  leafAmount: Map<string, number>,
): number {
  if (!node.isPlaceholder) {
    return node.currency === currency ? (leafAmount.get(node.id) ?? 0) : 0;
  }
  let sum = 0;
  for (const child of descendants(book, node.id)) {
    if (child.isPlaceholder) continue;
    if (child.currency !== currency) continue;
    sum += leafAmount.get(child.id) ?? 0;
  }
  return sum;
}

export function periodBreakdown(
  book: Book,
  range: { from: string; to: string },
  accountId: string,
  currency?: CurrencyCode,
): Result<PeriodBreakdown> {
  if (!isCalendarDate(range.from)) {
    return err("ENTRY_DATE_INVALID", `Invalid date ${range.from}`, { date: range.from });
  }
  if (!isCalendarDate(range.to)) {
    return err("ENTRY_DATE_INVALID", `Invalid date ${range.to}`, { date: range.to });
  }

  const account = findAccount(book, accountId);
  if (!account) return err("ACCOUNT_NOT_FOUND", "Account not found", { id: accountId });
  if (account.type !== "expense") {
    return err("ACCOUNT_TYPE_MISMATCH", "Statistics covers expense accounts only", {
      id: accountId,
    });
  }

  const leaves = account.isPlaceholder
    ? descendants(book, accountId).filter((a) => !a.isPlaceholder && a.type === "expense")
    : [account];

  const leafAmount = new Map<string, number>();
  const byCurrency: Record<string, number> = {};
  for (const leaf of leaves) {
    const signed = periodSigned(book, leaf, range);
    leafAmount.set(leaf.id, signed);
    if (signed !== 0) {
      byCurrency[leaf.currency] = (byCurrency[leaf.currency] ?? 0) + signed;
    }
  }

  const currencies = Object.keys(byCurrency)
    .filter((code) => byCurrency[code] !== 0)
    .sort((a, b) => {
      if (a === book.homeCurrency) return -1;
      if (b === book.homeCurrency) return 1;
      return a.localeCompare(b);
    });

  const resolved =
    currency !== undefined && currencies.includes(currency)
      ? currency
      : currencies.includes(book.homeCurrency)
        ? book.homeCurrency
        : (currencies[0] ?? book.homeCurrency);

  const total = subtreeAmount(book, account, resolved, leafAmount) as MinorUnits;

  const children: PeriodSlice[] = [];
  if (account.isPlaceholder) {
    for (const child of book.accounts) {
      if (child.parentId !== account.id) continue;
      const amount = subtreeAmount(book, child, resolved, leafAmount);
      if (amount <= 0) continue;
      children.push({
        id: child.id,
        name: child.name,
        isGroup: child.isPlaceholder,
        amount: amount as MinorUnits,
      });
    }
    children.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  }

  const ancestors: Array<{ id: string; name: string }> = [];
  let current = account.parentId ? findAccount(book, account.parentId) : undefined;
  while (current) {
    ancestors.unshift({ id: current.id, name: current.name });
    current = current.parentId ? findAccount(book, current.parentId) : undefined;
  }

  return ok({
    accountId: account.id,
    name: account.name,
    isGroup: account.isPlaceholder,
    currency: resolved,
    total,
    children,
    currencies,
    ancestors,
  });
}

export function journal(
  book: Book,
  filter?: { from?: string; to?: string; accountId?: string },
): Result<Book["journal"]> {
  if (filter?.from !== undefined && !isCalendarDate(filter.from)) {
    return err("ENTRY_DATE_INVALID", `Invalid date ${filter.from}`, { date: filter.from });
  }
  if (filter?.to !== undefined && !isCalendarDate(filter.to)) {
    return err("ENTRY_DATE_INVALID", `Invalid date ${filter.to}`, { date: filter.to });
  }
  if (filter?.accountId !== undefined && !findAccount(book, filter.accountId)) {
    return err("ACCOUNT_NOT_FOUND", "Account not found", { id: filter.accountId });
  }

  // A group holds no postings of its own, so filtering by one means its whole subtree.
  const scope =
    filter?.accountId === undefined
      ? null
      : new Set([filter.accountId, ...descendants(book, filter.accountId).map((a) => a.id)]);

  const rows = book.journal.filter((entry) => {
    if (filter?.from && entry.date < filter.from) return false;
    if (filter?.to && entry.date > filter.to) return false;
    if (scope && !entry.postings.some((p) => scope.has(p.accountId))) return false;
    return true;
  });
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
  return ok(rows.map((entry) => structuredClone(entry)));
}
