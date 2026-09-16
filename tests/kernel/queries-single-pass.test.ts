import { describe, expect, it } from "vitest";
import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import {
  balance,
  balanceAsOf,
  balanceInRange,
  budgetReport,
  periodBreakdown,
  periodTotals,
  trialBalance,
} from "../../src/kernel/queries";
import type { AccountType, Book } from "../../src/kernel/types";
import { NOW, unwrap } from "../helpers";

const AUGUST = { from: "2026-08-01", to: "2026-08-31" };

function add(
  book: Book,
  name: string,
  type: AccountType,
  parentId: string | null,
  isPlaceholder: boolean,
): Book {
  return unwrap(
    createAccount(book, { parentId, name, type, currency: "ILS", isPlaceholder }, NOW),
  );
}

function post(book: Book, from: string, to: string, date: string, amount: number): Book {
  return unwrap(
    postEntry(
      book,
      {
        date,
        description: `${date}`,
        postings: [
          { accountId: to, side: "debit", amount },
          { accountId: from, side: "credit", amount },
        ],
      },
      NOW,
    ),
  );
}

/** One asset leaf, one income leaf, one expense group with two leaves — so every
 * query below has more than one account to loop over. */
function fixture() {
  let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
  book = add(book, "Cash", "asset", null, false);
  book = add(book, "Salary", "income", null, false);
  book = add(book, "Expenses", "expense", null, true);
  const cash = book.accounts[0].id;
  const salary = book.accounts[1].id;
  const expenses = book.accounts[2].id;
  book = add(book, "Food", "expense", expenses, false);
  book = add(book, "Travel", "expense", expenses, false);
  const food = book.accounts[3].id;
  const travel = book.accounts[4].id;
  book = post(book, salary, cash, "2026-08-01", 500000);
  book = post(book, cash, food, "2026-08-10", 3000);
  book = post(book, cash, travel, "2026-08-12", 9000);
  book = post(book, cash, food, "2026-09-01", 5000);
  return { book, cash, salary, expenses, food, travel };
}

/** Counts every `for…of` over the journal. Only `Symbol.iterator` is counted, so a
 * query that walks the array by index would read as zero passes and fail too. */
function passesOf(book: Book, query: (book: Book) => unknown): number {
  let passes = 0;
  const journal = new Proxy(book.journal, {
    get(target, prop, receiver) {
      if (prop === Symbol.iterator) passes += 1;
      return Reflect.get(target, prop, receiver);
    },
  });
  query({ ...book, journal });
  return passes;
}

describe("each query reads the journal exactly once", () => {
  it("balance of a leaf", () => {
    const f = fixture();
    expect(passesOf(f.book, (b) => unwrap(balance(b, f.cash)))).toBe(1);
  });

  it("balanceAsOf of a group", () => {
    const f = fixture();
    expect(passesOf(f.book, (b) => unwrap(balanceAsOf(b, f.expenses, "2026-08-31")))).toBe(1);
  });

  it("balanceInRange of a group", () => {
    const f = fixture();
    expect(passesOf(f.book, (b) => unwrap(balanceInRange(b, f.expenses, AUGUST)))).toBe(1);
  });

  it("trialBalance", () => {
    const f = fixture();
    expect(passesOf(f.book, (b) => unwrap(trialBalance(b)))).toBe(1);
  });

  it("periodTotals", () => {
    const f = fixture();
    expect(passesOf(f.book, (b) => unwrap(periodTotals(b, AUGUST)))).toBe(1);
  });

  it("periodBreakdown of a group", () => {
    const f = fixture();
    expect(passesOf(f.book, (b) => unwrap(periodBreakdown(b, AUGUST, f.expenses)))).toBe(1);
  });

  it("budgetReport", () => {
    const f = fixture();
    expect(passesOf(f.book, (b) => unwrap(budgetReport(b, "month", AUGUST)))).toBe(1);
  });
});
