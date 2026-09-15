import { createAccount } from "../src/kernel/accounts.ts";
import { setBudget } from "../src/kernel/budgets.ts";
import { createBook } from "../src/kernel/create-book.ts";
import { postEntry } from "../src/kernel/journal.ts";
import { createRecurrence } from "../src/kernel/recurrences.ts";
import type { Result } from "../src/kernel/result.ts";
import type { AccountType, Book, CurrencyCode } from "../src/kernel/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function must<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** `monthsBack` months before `today`, on day `dom`, clamped so nothing lands in the future. */
function dateIn(today: string, monthsBack: number, dom: number): string {
  const [year, month] = today.split("-").map(Number);
  const todayDom = Number(today.slice(8, 10));
  const day = monthsBack === 0 ? Math.min(dom, todayDom) : dom;
  return new Date(Date.UTC(year, month - 1 - monthsBack, day)).toISOString().slice(0, 10);
}

export function buildDemoBook(today: string): Book {
  let book = must(createBook({ name: "Household", homeCurrency: "USD" }, NOW));
  const id: Record<string, string> = {};

  const add = (
    parentId: string | null,
    name: string,
    type: AccountType,
    currency: CurrencyCode,
    isPlaceholder: boolean,
  ): string => {
    book = must(createAccount(book, { parentId, name, type, currency, isPlaceholder }, NOW));
    const created = book.accounts[book.accounts.length - 1].id;
    id[name] = created;
    return created;
  };

  // The four roots the app itself seeds, with the English names from `locales/en.json`.
  // Built here rather than through `createHousehold`, which reads them from i18n and would
  // drag the whole app layer into a node script.
  const assets = add(null, "Assets", "asset", "USD", true);
  const liabilities = add(null, "Liabilities", "liability", "USD", true);
  const income = add(null, "Income", "income", "USD", true);
  const expenses = add(null, "Expenses", "expense", "USD", true);

  add(assets, "Checking", "asset", "USD", false);
  add(assets, "Cash", "asset", "USD", false);
  add(assets, "Savings", "asset", "EUR", false);
  add(liabilities, "Credit card", "liability", "USD", false);
  add(income, "Salary", "income", "USD", false);
  add(income, "Freelance", "income", "USD", false);
  for (const name of ["Groceries", "Rent", "Transport", "Eating out", "Utilities", "Health"]) {
    add(expenses, name, "expense", "USD", false);
  }

  const entry = (
    date: string,
    description: string,
    postings: { accountId: string; side: "debit" | "credit"; amount: number }[],
    fx?: { baseCurrency: CurrencyCode; quoteCurrency: CurrencyCode; baseAmount: number; quoteAmount: number },
  ) => {
    book = must(postEntry(book, { date, description, postings, ...(fx ? { fx } : {}) }, NOW));
  };

  const spend = (date: string, description: string, category: string, from: string, amount: number) =>
    entry(date, description, [
      { accountId: id[category], side: "debit", amount },
      { accountId: id[from], side: "credit", amount },
    ]);

  for (const back of [2, 1, 0]) {
    entry(dateIn(today, back, 1), "Salary", [
      { accountId: id.Checking, side: "debit", amount: 620000 },
      { accountId: id.Salary, side: "credit", amount: 620000 },
    ]);
    spend(dateIn(today, back, 2), "Rent", "Rent", "Checking", 210000);
    spend(dateIn(today, back, 4), "Electricity and water", "Utilities", "Checking", 18400);
    spend(dateIn(today, back, 5), "Supermarket", "Groceries", "Credit card", 21350);
    spend(dateIn(today, back, 9), "Supermarket", "Groceries", "Credit card", 17820);
    spend(dateIn(today, back, 11), "Bus pass", "Transport", "Cash", 7500);
    spend(dateIn(today, back, 12), "Lunch out", "Eating out", "Credit card", 4650);
  }

  entry(dateIn(today, 1, 18), "Website project", [
    { accountId: id.Checking, side: "debit", amount: 95000 },
    { accountId: id.Freelance, side: "credit", amount: 95000 },
  ]);

  // One payment split across two categories — the feature the page claims and nothing else shows.
  entry(dateIn(today, 0, 8), "Pharmacy and groceries", [
    { accountId: id.Groceries, side: "debit", amount: 8400 },
    { accountId: id.Health, side: "debit", amount: 3600 },
    { accountId: id["Credit card"], side: "credit", amount: 12000 },
  ]);

  // One cross-currency transfer. `fx` amounts must equal the per-currency nets of the postings,
  // which `validatePostings` checks: USD net 54000, EUR net 50000.
  entry(
    dateIn(today, 0, 6),
    "To euro savings",
    [
      { accountId: id.Savings, side: "debit", amount: 50000 },
      { accountId: id.Checking, side: "credit", amount: 54000 },
    ],
    { baseCurrency: "USD", quoteCurrency: "EUR", baseAmount: 54000, quoteAmount: 50000 },
  );

  for (const [category, limit] of [
    ["Groceries", 90000],
    ["Eating out", 30000],
    ["Transport", 20000],
    ["Rent", 230000],
    ["Utilities", 22000],
  ] as const) {
    book = must(setBudget(book, { accountId: id[category], period: "month", currency: "USD", limit }, NOW));
  }

  // Two bills that repeat, so the Dashboard's recurring card is never empty. The start date
  // is the first of `today`'s own month, not a date months back: occurrences are derived
  // from it, and an earlier start would queue up a due occurrence for every month since.
  const startOfThisMonth = `${today.slice(0, 7)}-01`;
  const recur = (description: string, toAccount: string, amount: number) => {
    book = must(
      createRecurrence(
        book,
        {
          description,
          fromAccountId: id.Checking,
          lines: [{ toAccountId: id[toAccount], amount }],
          every: 1,
          unit: "month",
          startDate: startOfThisMonth,
          endDate: null,
        },
        NOW,
      ),
    );
  };
  recur("Rent", "Rent", 210000);
  recur("Electricity and water", "Utilities", 18400);

  return book;
}
