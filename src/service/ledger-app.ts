import {
  accountPath,
  balance,
  chart,
  createAccount,
  createBook,
  deleteAccount,
  deleteEntry as kernelDeleteEntry,
  journal,
  periodBreakdown,
  periodTotals,
  postEntry,
  recordOpeningBalance,
  updateAccount,
  updateEntry as kernelUpdateEntry,
  type Account,
  type AccountBalance,
  type AccountNode,
  type AccountType,
  type Book,
  type CurrencyCode,
  type FxSpec,
  type JournalEntry,
  type MinorUnits,
  type PeriodBreakdown,
  type PeriodTotals,
} from "../kernel";
import type { PostingInput } from "../kernel/entry-validation";
import { err, ok, type Result } from "../kernel/result";
import type { LedgerRepository } from "../ports/ledger-repository";
import i18n from "../app/i18n";
import { todayCalendarDate } from "./dates";

export const HOUSEHOLD_BOOK_NAME = "Household";

export const ROOT_SEEDS: ReadonlyArray<{ readonly name: string; readonly type: AccountType }> = [
  { get name() { return i18n.t("accounts.rootAssets"); }, type: "asset" },
  { get name() { return i18n.t("accounts.rootLiabilities"); }, type: "liability" },
  { get name() { return i18n.t("accounts.rootIncome"); }, type: "income" },
  { get name() { return i18n.t("accounts.rootExpenses"); }, type: "expense" },
];

export type EntryLine = { toAccountId: string; amount: MinorUnits };

export type EntryInput = {
  date: string;
  description: string;
  fromAccountId: string;
  fromAmount?: MinorUnits;
  lines: EntryLine[];
};

export type AccountOption = { id: string; path: string; depth: number };

async function commit(repo: LedgerRepository, next: Book): Promise<Result<Book>> {
  const saved = await repo.save(next);
  if (!saved.ok) return saved;
  return ok(next);
}

function isSystemAccountId(id: string): boolean {
  return id.startsWith("sys:");
}

function isRootCategory(account: Account): boolean {
  return account.parentId === null;
}

function withoutSystemAccounts(nodes: AccountNode[]): AccountNode[] {
  return nodes
    .filter((node) => !isSystemAccountId(node.id))
    .map((node) => ({ ...node, children: withoutSystemAccounts(node.children) }));
}

function descendantIds(book: Book, rootId: string): Set<string> {
  const ids = new Set<string>();
  const walk = (parentId: string) => {
    for (const account of book.accounts) {
      if (account.parentId !== parentId || ids.has(account.id)) continue;
      ids.add(account.id);
      walk(account.id);
    }
  };
  walk(rootId);
  return ids;
}

function currencyOf(book: Book, accountId: string): string | null {
  return book.accounts.find((a) => a.id === accountId)?.currency ?? null;
}

/** Returns an error Result for invalid input, or null when valid. */
function invalidEntryInput(book: Book, input: EntryInput): Result<Book> | null {
  if (input.lines.length === 0) {
    return err("ENTRY_TOO_FEW_ACCOUNTS", "Add at least one line");
  }
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (!Number.isInteger(line.amount) || line.amount <= 0) {
      return err("ENTRY_AMOUNT_INVALID", "Amount must be an integer > 0", {
        amount: line.amount,
      });
    }
    if (line.toAccountId === input.fromAccountId) {
      return err("ENTRY_TOO_FEW_ACCOUNTS", "From and To must be different accounts");
    }
    if (seen.has(line.toAccountId)) {
      return err("ENTRY_TOO_FEW_ACCOUNTS", "Each line must use a different account", {
        toAccountId: line.toAccountId,
      });
    }
    seen.add(line.toAccountId);
  }

  const fromCurrency = currencyOf(book, input.fromAccountId);
  if (fromCurrency === null) {
    return err("ACCOUNT_NOT_FOUND", "Account not found", { accountId: input.fromAccountId });
  }
  const lineCurrencies = new Set<string>();
  for (const line of input.lines) {
    const currency = currencyOf(book, line.toAccountId);
    if (currency === null) {
      return err("ACCOUNT_NOT_FOUND", "Account not found", { accountId: line.toAccountId });
    }
    lineCurrencies.add(currency);
  }
  if (lineCurrencies.size > 1) {
    return err("ENTRY_FX_CURRENCY_COUNT", "All To lines must use the same currency", {
      currencies: [...lineCurrencies],
    });
  }

  const crossCurrency = !lineCurrencies.has(fromCurrency);
  if (crossCurrency) {
    if (input.lines.length > 1) {
      return err("ENTRY_FX_CURRENCY_COUNT", "Cross-currency entries need exactly one To line", {
        lines: input.lines.length,
      });
    }
    if (
      input.fromAmount === undefined ||
      !Number.isInteger(input.fromAmount) ||
      input.fromAmount <= 0
    ) {
      return err("ENTRY_AMOUNT_INVALID", "Enter the amount leaving the source account", {
        fromAmount: input.fromAmount,
      });
    }
  } else if (input.fromAmount !== undefined) {
    return err("ENTRY_AMOUNT_INVALID", "Same-currency entries derive the source amount", {
      fromAmount: input.fromAmount,
    });
  }

  return null;
}

/** Postings plus the fx spec for the entry. Call only after invalidEntryInput passes. */
function entryShape(
  book: Book,
  input: EntryInput,
): { postings: PostingInput[]; fx: FxSpec | null } {
  const total = input.lines.reduce((sum, line) => sum + line.amount, 0);
  const fromCurrency = currencyOf(book, input.fromAccountId)!;
  const lineCurrency = currencyOf(book, input.lines[0].toAccountId)!;
  const creditAmount = input.fromAmount ?? total;
  const postings = [
    ...input.lines.map((line) => ({
      accountId: line.toAccountId,
      side: "debit" as const,
      amount: line.amount,
    })),
    { accountId: input.fromAccountId, side: "credit" as const, amount: creditAmount },
  ];
  const fx =
    fromCurrency === lineCurrency
      ? null
      : {
          baseCurrency: fromCurrency,
          baseAmount: creditAmount,
          quoteCurrency: lineCurrency,
          quoteAmount: total,
        };
  return { postings, fx };
}

export function inferEntryLines(entry: JournalEntry): {
  fromAccountId: string;
  fromAmount: MinorUnits;
  lines: EntryLine[];
  total: MinorUnits;
  fx?: FxSpec;
} | null {
  const credits = entry.postings.filter((p) => p.side === "credit");
  const debits = entry.postings.filter((p) => p.side === "debit");
  if (credits.length !== 1 || debits.length === 0) return null;

  const credit = credits[0];
  const total = debits.reduce((sum, p) => sum + p.amount, 0);
  const lines = debits.map((p) => ({ toAccountId: p.accountId, amount: p.amount }));

  if (credit.amount === total) {
    return { fromAccountId: credit.accountId, fromAmount: total, lines, total };
  }

  const fx = entry.fx;
  if (
    debits.length !== 1 ||
    fx === undefined ||
    fx.baseAmount !== credit.amount ||
    fx.quoteAmount !== total
  ) {
    return null;
  }

  return { fromAccountId: credit.accountId, fromAmount: credit.amount, lines, total, fx };
}

export function createLedgerApp(repo: LedgerRepository) {
  return {
    async boot(): Promise<Result<Book | null>> {
      return repo.load();
    },

    async createHousehold(homeCurrency: CurrencyCode): Promise<Result<Book>> {
      const created = createBook({ name: HOUSEHOLD_BOOK_NAME, homeCurrency });
      if (!created.ok) return created;
      let book = created.value;
      for (const seed of ROOT_SEEDS) {
        const next = createAccount(book, {
          parentId: null,
          name: seed.name,
          type: seed.type,
          currency: homeCurrency,
          isPlaceholder: true,
        });
        if (!next.ok) return next;
        book = next.value;
      }
      return commit(repo, book);
    },

    async addAccount(
      book: Book,
      input: {
        parentId: string;
        name: string;
        isPlaceholder: boolean;
        currency?: CurrencyCode;
        openingAmount?: MinorUnits;
        openingDate?: string;
      },
    ): Promise<Result<Book>> {
      const parent = book.accounts.find((a) => a.id === input.parentId);
      if (!parent) {
        return err("ACCOUNT_PARENT_INVALID", "Parent account not found", {
          parentId: input.parentId,
        });
      }
      if (isSystemAccountId(parent.id)) {
        return err("ACCOUNT_IS_SYSTEM", "Cannot add accounts under a system account", {
          parentId: input.parentId,
        });
      }

      const openingAmount = input.openingAmount;
      if (input.isPlaceholder && openingAmount !== undefined && openingAmount > 0) {
        return err("ACCOUNT_IS_PLACEHOLDER", "A group cannot hold an opening balance", {
          parentId: input.parentId,
        });
      }

      const created = createAccount(book, {
        parentId: parent.id,
        name: input.name,
        type: parent.type,
        currency: input.isPlaceholder ? book.homeCurrency : (input.currency ?? book.homeCurrency),
        isPlaceholder: input.isPlaceholder,
      });
      if (!created.ok) return created;

      let next = created.value;
      if (openingAmount !== undefined && openingAmount > 0) {
        const known = new Set(book.accounts.map((a) => a.id));
        const leaf = next.accounts.find((a) => !known.has(a.id));
        if (!leaf) {
          return err("ACCOUNT_NOT_FOUND", "Created account not found");
        }
        const opened = recordOpeningBalance(next, {
          accountId: leaf.id,
          amount: openingAmount,
          date: input.openingDate ?? todayCalendarDate(),
          groupName: i18n.t("accounts.openingBalances"),
        });
        if (!opened.ok) {
          const saved = await commit(repo, next);
          if (!saved.ok) return saved;
          return opened;
        }
        next = opened.value;
      }

      return commit(repo, next);
    },

    async editAccount(
      book: Book,
      input: { id: string; name?: string; parentId?: string; isPlaceholder?: boolean },
    ): Promise<Result<Book>> {
      const account = book.accounts.find((a) => a.id === input.id);
      if (!account) {
        return err("ACCOUNT_NOT_FOUND", "Account not found", { id: input.id });
      }
      if (isSystemAccountId(account.id)) {
        return err("ACCOUNT_IS_SYSTEM", "System accounts cannot be edited", { id: input.id });
      }
      if (isRootCategory(account)) {
        if (input.parentId !== undefined) {
          return err("ACCOUNT_IS_SYSTEM", "Root categories cannot be moved", { id: input.id });
        }
        if (input.isPlaceholder === false) {
          return err("ACCOUNT_IS_SYSTEM", "Root categories must stay groups", { id: input.id });
        }
      }
      if (input.parentId !== undefined && isSystemAccountId(input.parentId)) {
        return err("ACCOUNT_IS_SYSTEM", "Cannot move an account under a system account", {
          parentId: input.parentId,
        });
      }

      const updated = updateAccount(book, {
        id: input.id,
        name: input.name,
        parentId: input.parentId,
        isPlaceholder: input.isPlaceholder,
      });
      if (!updated.ok) return updated;
      return commit(repo, updated.value);
    },

    async removeAccount(book: Book, id: string): Promise<Result<Book>> {
      const account = book.accounts.find((a) => a.id === id);
      if (!account) {
        return err("ACCOUNT_NOT_FOUND", "Account not found", { id });
      }
      if (isSystemAccountId(account.id)) {
        return err("ACCOUNT_IS_SYSTEM", "System accounts cannot be deleted", { id });
      }
      if (isRootCategory(account)) {
        return err("ACCOUNT_IS_SYSTEM", "Root categories cannot be deleted", { id });
      }
      const deleted = deleteAccount(book, id);
      if (!deleted.ok) return deleted;
      return commit(repo, deleted.value);
    },

    async addEntry(book: Book, input: EntryInput): Promise<Result<Book>> {
      const invalid = invalidEntryInput(book, input);
      if (invalid) return invalid;
      const shape = entryShape(book, input);
      const posted = postEntry(book, {
        date: input.date,
        description: input.description,
        postings: shape.postings,
        fx: shape.fx ?? undefined,
      });
      if (!posted.ok) return posted;
      return commit(repo, posted.value);
    },

    async updateEntry(book: Book, entryId: string, input: EntryInput): Promise<Result<Book>> {
      const existing = book.journal.find((e) => e.id === entryId);
      if (!existing) return err("ENTRY_NOT_FOUND", "Journal entry not found", { id: entryId });
      if (existing.kind !== "standard") {
        return err("BOOK_INVALID", "Only standard transfers can be edited");
      }
      const invalid = invalidEntryInput(book, input);
      if (invalid) return invalid;
      const shape = entryShape(book, input);
      const updated = kernelUpdateEntry(book, {
        id: entryId,
        date: input.date,
        description: input.description,
        postings: shape.postings,
        fx: shape.fx,
      });
      if (!updated.ok) return updated;
      return commit(repo, updated.value);
    },

    async deleteEntry(book: Book, entryId: string): Promise<Result<Book>> {
      const deleted = kernelDeleteEntry(book, entryId);
      if (!deleted.ok) return deleted;
      return commit(repo, deleted.value);
    },

    listJournal(
      book: Book,
      filter?: { from?: string; to?: string; accountId?: string },
    ): Result<JournalEntry[]> {
      return journal(book, filter);
    },

    balanceOf(book: Book, accountId: string): Result<AccountBalance> {
      return balance(book, accountId);
    },

    periodTotals(
      book: Book,
      range: { from: string; to: string },
    ): Result<PeriodTotals> {
      return periodTotals(book, range);
    },

    periodBreakdown(
      book: Book,
      range: { from: string; to: string },
      accountId: string,
      currency?: CurrencyCode,
    ): Result<PeriodBreakdown> {
      return periodBreakdown(book, range, accountId, currency);
    },

    accountTree(book: Book): Result<AccountNode[]> {
      const built = chart(book);
      if (!built.ok) return built;
      return ok(withoutSystemAccounts(built.value));
    },

    /**
     * Groups that may parent an account: placeholders only, matching type, and — when
     * moving an existing account — excluding itself and its own subtree.
     */
    parentOptions(
      book: Book,
      input?: { forAccountId?: string; type?: AccountType },
    ): AccountOption[] {
      const subject = input?.forAccountId
        ? book.accounts.find((a) => a.id === input.forAccountId)
        : undefined;
      const type = subject?.type ?? input?.type;
      const blocked = subject ? descendantIds(book, subject.id) : new Set<string>();
      if (subject) blocked.add(subject.id);

      return book.accounts
        .filter(
          (a) =>
            a.isPlaceholder &&
            !isSystemAccountId(a.id) &&
            !blocked.has(a.id) &&
            (type === undefined || a.type === type),
        )
        .map((a) => {
          const path = accountPath(book, a.id);
          return { id: a.id, path: path.ok ? path.value : a.name };
        })
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((option) => ({ ...option, depth: option.path.split(":").length - 1 }));
    },
  };
}
