import { describe, expect, it } from "vitest";
import { postEntry } from "../../src/kernel/journal";
import { recordOpeningBalance } from "../../src/kernel/opening";
import { balance, runningBalances } from "../../src/kernel/queries";
import type { Account, AccountType, Book, FxSpec, Posting } from "../../src/kernel/types";
import { NOW, unwrap, unwrapErr } from "../helpers";
import { realBook, ROOT } from "../helpers/book";

function leaf(id: string, parentId: string, type: AccountType, currency = "USD"): Account {
  return { id, parentId, name: id, type, currency, isPlaceholder: false, updatedAt: NOW };
}

function seeded(): Book {
  const book = realBook("USD");
  book.accounts.push(
    leaf("checking", ROOT.asset, "asset"),
    leaf("cash", ROOT.asset, "asset"),
    leaf("savings", ROOT.asset, "asset", "EUR"),
    leaf("card", ROOT.liability, "liability"),
    leaf("salary", ROOT.income, "income"),
    leaf("rent", ROOT.expense, "expense"),
  );
  return book;
}

const debit = (accountId: string, amount: number): Posting => ({ accountId, side: "debit", amount });
const credit = (accountId: string, amount: number): Posting => ({ accountId, side: "credit", amount });

/** Explicit ids, so same-day order is the test's to choose rather than the clock's. */
function post(book: Book, id: string, date: string, postings: Posting[], fx?: FxSpec): Book {
  return unwrap(postEntry(book, { id, date, description: id, postings, ...(fx ? { fx } : {}) }, NOW));
}

function chain(): Book {
  let book = seeded();
  book = post(book, "e1", "2026-10-01", [debit("checking", 620000), credit("salary", 620000)]);
  book = post(book, "e2", "2026-10-02", [debit("rent", 210000), credit("checking", 210000)]);
  book = post(book, "e3", "2026-10-04", [debit("rent", 18400), credit("checking", 18400)]);
  book = post(book, "e4", "2026-10-05", [debit("cash", 1000), credit("salary", 1000)]);
  return book;
}

describe("runningBalances", () => {
  it("carries an account's balance after each entry", () => {
    const after = unwrap(runningBalances(chain(), "checking"));
    expect(after.get("e1")).toEqual({ USD: 620000 });
    expect(after.get("e2")).toEqual({ USD: 410000 });
    expect(after.get("e3")).toEqual({ USD: 391600 });
  });

  it("leaves out entries that never touch the subtree", () => {
    const after = unwrap(runningBalances(chain(), "checking"));
    expect(after.has("e4")).toBe(false);
    expect(after.size).toBe(3);
  });

  it("ends on the balance the accounts screen shows", () => {
    const book = chain();
    const after = unwrap(runningBalances(book, "checking"));
    const now = unwrap(balance(book, "checking"));
    expect(now).toEqual({ kind: "leaf", currency: "USD", amount: 391600 });
    expect(after.get("e3")).toEqual({ USD: 391600 });
  });

  it("runs same-day entries in id order, not in the order they were posted", () => {
    let book = seeded();
    book = post(book, "e-b", "2026-10-03", [debit("rent", 30000), credit("checking", 30000)]);
    book = post(book, "e-a", "2026-10-03", [debit("checking", 100000), credit("salary", 100000)]);
    const after = unwrap(runningBalances(book, "checking"));
    expect(after.get("e-a")).toEqual({ USD: 100000 });
    expect(after.get("e-b")).toEqual({ USD: 70000 });
  });

  it("counts entries from earlier months", () => {
    let book = seeded();
    book = post(book, "e0", "2026-09-15", [debit("checking", 500000), credit("salary", 500000)]);
    book = post(book, "e1", "2026-10-01", [debit("rent", 210000), credit("checking", 210000)]);
    expect(unwrap(runningBalances(book, "checking")).get("e1")).toEqual({ USD: 290000 });
  });

  it("shows a card's debt as a positive number that a purchase raises and a repayment lowers", () => {
    let book = seeded();
    book = post(book, "p1", "2026-10-05", [debit("rent", 4650), credit("card", 4650)]);
    book = post(book, "p2", "2026-10-15", [debit("card", 4000), credit("checking", 4000)]);
    const after = unwrap(runningBalances(book, "card"));
    expect(after.get("p1")).toEqual({ USD: 4650 });
    expect(after.get("p2")).toEqual({ USD: 650 });
  });

  it("carries a group's balance only in the currencies each entry touched", () => {
    let book = seeded();
    book = post(book, "g1", "2026-10-01", [debit("checking", 620000), credit("salary", 620000)]);
    book = post(book, "g2", "2026-10-06", [debit("savings", 50000), credit("checking", 54000)], {
      baseCurrency: "USD",
      baseAmount: 54000,
      quoteCurrency: "EUR",
      quoteAmount: 50000,
    });
    book = post(book, "g3", "2026-10-07", [debit("cash", 20000), credit("checking", 20000)]);
    book = post(book, "g4", "2026-10-08", [debit("rent", 7500), credit("cash", 7500)]);
    const after = unwrap(runningBalances(book, ROOT.asset));
    expect(after.get("g1")).toEqual({ USD: 620000 });
    expect(after.get("g2")).toEqual({ USD: 566000, EUR: 50000 });
    expect(after.get("g3")).toEqual({ USD: 566000 });
    expect(after.get("g4")).toEqual({ USD: 558500 });
  });

  it("counts an opening balance like any other entry", () => {
    let book = unwrap(recordOpeningBalance(seeded(), { accountId: "checking", amount: 100000, date: "2026-09-30" }, NOW));
    book = post(book, "e1", "2026-10-01", [debit("checking", 620000), credit("salary", 620000)]);
    const after = unwrap(runningBalances(book, "checking"));
    expect(after.get("opening:checking")).toEqual({ USD: 100000 });
    expect(after.get("e1")).toEqual({ USD: 720000 });
  });

  it("refuses an unknown account", () => {
    expect(unwrapErr(runningBalances(seeded(), "nope")).code).toBe("ACCOUNT_NOT_FOUND");
  });
});
