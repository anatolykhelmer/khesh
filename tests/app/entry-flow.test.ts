import { describe, expect, it } from "vitest";
import { entryFlow, flowScope } from "../../src/app/entry-flow";
import { recordOpeningBalance } from "../../src/kernel";
import type { Account, AccountType, Book, FxSpec, JournalEntry, Posting } from "../../src/kernel/types";
import { NOW, unwrap } from "../helpers";
import { realBook, ROOT } from "../helpers/book";

function leaf(id: string, parentId: string, type: AccountType, currency = "ILS"): Account {
  return { id, parentId, name: id, type, currency, isPlaceholder: false, updatedAt: NOW };
}

function seeded(): Book {
  const book = realBook();
  book.accounts.push(
    leaf("bank", ROOT.asset, "asset"),
    leaf("savings", ROOT.asset, "asset"),
    leaf("usd", ROOT.asset, "asset", "USD"),
    leaf("card", ROOT.liability, "liability"),
    leaf("salary", ROOT.income, "income"),
    leaf("groceries", ROOT.expense, "expense"),
  );
  return book;
}

const debit = (accountId: string, amount: number): Posting => ({ accountId, side: "debit", amount });
const credit = (accountId: string, amount: number): Posting => ({ accountId, side: "credit", amount });

function entry(postings: Posting[], fx?: FxSpec): JournalEntry {
  return {
    id: "e1",
    date: "2026-10-01",
    description: "",
    kind: "standard",
    postings,
    ...(fx ? { fx } : {}),
    updatedAt: NOW,
  };
}

const salaryIn = entry([debit("bank", 120000), credit("salary", 120000)]);
const groceriesFromBank = entry([debit("groceries", 30000), credit("bank", 30000)]);
const groceriesOnCard = entry([debit("groceries", 30000), credit("card", 30000)]);
const cardRepayment = entry([debit("card", 100000), credit("bank", 100000)]);
const bankToSavings = entry([debit("savings", 20000), credit("bank", 20000)]);
const split = entry([debit("groceries", 30000), debit("savings", 20000), credit("bank", 50000)]);

describe("flowScope", () => {
  it("is every asset and liability account when nothing is filtered", () => {
    const book = seeded();
    expect([...flowScope(book, undefined)].sort()).toEqual(
      ["bank", "card", ROOT.asset, ROOT.liability, "savings", "usd"].sort(),
    );
  });

  it("is the account and its descendants under an asset group filter", () => {
    const book = seeded();
    expect([...flowScope(book, ROOT.asset)].sort()).toEqual(["bank", ROOT.asset, "savings", "usd"].sort());
  });

  it("is empty under an expense or income filter", () => {
    const book = seeded();
    expect(flowScope(book, "groceries").size).toBe(0);
    expect(flowScope(book, "salary").size).toBe(0);
  });

  it("is empty under an equity filter", () => {
    const book = unwrap(recordOpeningBalance(seeded(), { accountId: "bank", amount: 500000, date: "2026-10-01" }, NOW));
    expect(flowScope(book, "sys:ob:ILS").size).toBe(0);
  });
});

describe("entryFlow", () => {
  it("signs income into an asset as a green gain", () => {
    const book = seeded();
    expect(entryFlow(salaryIn, book, flowScope(book, "bank"))).toEqual({ tone: "pos", text: "+1,200.00 ₪" });
    expect(entryFlow(salaryIn, book, flowScope(book, undefined))).toEqual({ tone: "pos", text: "+1,200.00 ₪" });
  });

  it("signs spending from an asset as a red loss", () => {
    const book = seeded();
    expect(entryFlow(groceriesFromBank, book, flowScope(book, "bank"))).toEqual({ tone: "neg", text: "-300.00 ₪" });
  });

  it("signs spending on a credit card as a red loss, since the debt grew", () => {
    const book = seeded();
    expect(entryFlow(groceriesOnCard, book, flowScope(book, "card"))).toEqual({ tone: "neg", text: "-300.00 ₪" });
    expect(entryFlow(groceriesOnCard, book, flowScope(book, undefined))).toEqual({ tone: "neg", text: "-300.00 ₪" });
  });

  it("reads a card repayment from each side, and as neutral against net worth", () => {
    const book = seeded();
    expect(entryFlow(cardRepayment, book, flowScope(book, "card"))).toEqual({ tone: "pos", text: "+1,000.00 ₪" });
    expect(entryFlow(cardRepayment, book, flowScope(book, "bank"))).toEqual({ tone: "neg", text: "-1,000.00 ₪" });
    expect(entryFlow(cardRepayment, book, flowScope(book, undefined))).toBeNull();
  });

  it("treats a transfer between own accounts as neutral", () => {
    const book = seeded();
    expect(entryFlow(bankToSavings, book, flowScope(book, undefined))).toBeNull();
  });

  it("treats a cross-currency transfer between own accounts as neutral, though its sum is not zero", () => {
    const book = seeded();
    const usdToBank = entry([debit("bank", 37000), credit("usd", 10000)], {
      baseCurrency: "USD",
      baseAmount: 10000,
      quoteCurrency: "ILS",
      quoteAmount: 37000,
    });
    expect(entryFlow(usdToBank, book, flowScope(book, undefined))).toBeNull();
  });

  it("shows an outgoing cross-currency entry in the viewed account's own currency", () => {
    const book = seeded();
    const usdToGroceries = entry([debit("groceries", 7400), credit("usd", 2000)], {
      baseCurrency: "USD",
      baseAmount: 2000,
      quoteCurrency: "ILS",
      quoteAmount: 7400,
    });
    expect(entryFlow(usdToGroceries, book, flowScope(book, "usd"))).toEqual({ tone: "neg", text: "-20.00 $" });
  });

  it("shows a split entry as what it meant for each point of view", () => {
    const book = seeded();
    expect(entryFlow(split, book, flowScope(book, "bank"))).toEqual({ tone: "neg", text: "-500.00 ₪" });
    expect(entryFlow(split, book, flowScope(book, "savings"))).toEqual({ tone: "pos", text: "+200.00 ₪" });
    expect(entryFlow(split, book, flowScope(book, undefined))).toEqual({ tone: "neg", text: "-300.00 ₪" });
    expect(entryFlow(split, book, flowScope(book, "groceries"))).toBeNull();
  });

  it("treats a transfer inside a filtered asset group as neutral, and income into it as a gain", () => {
    const book = seeded();
    const assets = flowScope(book, ROOT.asset);
    expect(entryFlow(bankToSavings, book, assets)).toBeNull();
    expect(entryFlow(salaryIn, book, assets)).toEqual({ tone: "pos", text: "+1,200.00 ₪" });
  });

  it("signs an opening balance without colour, up for an asset and down for a debt", () => {
    const withBank = unwrap(recordOpeningBalance(seeded(), { accountId: "bank", amount: 500000, date: "2026-10-01" }, NOW));
    const book = unwrap(recordOpeningBalance(withBank, { accountId: "card", amount: 300000, date: "2026-10-01" }, NOW));
    const bankOpening = book.journal.find((e) => e.id === "opening:bank");
    const cardOpening = book.journal.find((e) => e.id === "opening:card");
    if (!bankOpening || !cardOpening) throw new Error("opening entries missing");
    const scope = flowScope(book, undefined);
    expect(entryFlow(bankOpening, book, scope)).toEqual({ tone: "none", text: "+5,000.00 ₪" });
    expect(entryFlow(cardOpening, book, scope)).toEqual({ tone: "none", text: "-3,000.00 ₪" });
  });

  it("leaves an opening balance as today under an equity filter", () => {
    const book = unwrap(recordOpeningBalance(seeded(), { accountId: "bank", amount: 500000, date: "2026-10-01" }, NOW));
    const opening = book.journal.find((e) => e.id === "opening:bank");
    if (!opening) throw new Error("opening entry missing");
    expect(entryFlow(opening, book, flowScope(book, "sys:ob:ILS"))).toBeNull();
  });

  it("signs a pending row without colour", () => {
    const book = seeded();
    expect(entryFlow(groceriesFromBank, book, flowScope(book, "bank"), { pending: true })).toEqual({
      tone: "none",
      text: "-300.00 ₪",
    });
  });

  it("leaves an entry with no posting in scope as today", () => {
    const book = unwrap(recordOpeningBalance(seeded(), { accountId: "bank", amount: 500000, date: "2026-10-01" }, NOW));
    const equityToIncome = entry([debit("sys:ob:ILS", 10000), credit("salary", 10000)]);
    expect(entryFlow(equityToIncome, book, flowScope(book, undefined))).toBeNull();
  });

  it("treats an entry whose in-scope postings cancel out as neutral", () => {
    const book = seeded();
    const cancelling = entry([
      debit("bank", 10000),
      credit("savings", 10000),
      debit("groceries", 5000),
      credit("salary", 5000),
    ]);
    expect(entryFlow(cancelling, book, flowScope(book, undefined))).toBeNull();
  });

  it("falls back to today's display when two currencies move inside the scope", () => {
    const book = seeded();
    const twoCurrencies = entry([credit("bank", 10000), credit("usd", 1000), debit("groceries", 13700)]);
    expect(entryFlow(twoCurrencies, book, flowScope(book, undefined))).toBeNull();
  });
});
