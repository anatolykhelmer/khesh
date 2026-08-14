import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { createLedgerApp, inferEntryLines } from "../../src/service/ledger-app";
import type { JournalEntry } from "../../src/kernel";
import { unwrap, unwrapErr } from "../helpers";

describe("LedgerApp entries", () => {
  async function threeLeaves() {
    const repo = createMemoryRepository(null);
    const app = createLedgerApp(repo);
    let book = unwrap(await app.createHousehold("ILS"));
    const assets = book.accounts.find((a) => a.name === "Assets")!;
    const expenses = book.accounts.find((a) => a.name === "Expenses")!;
    book = unwrap(
      await app.addAccount(book, { parentId: assets.id, name: "Cash", isPlaceholder: false }),
    );
    book = unwrap(
      await app.addAccount(book, {
        parentId: expenses.id,
        name: "Groceries",
        isPlaceholder: false,
      }),
    );
    book = unwrap(
      await app.addAccount(book, {
        parentId: expenses.id,
        name: "Household",
        isPlaceholder: false,
      }),
    );
    const cash = book.accounts.find((a) => a.name === "Cash")!;
    const groceries = book.accounts.find((a) => a.name === "Groceries")!;
    const household = book.accounts.find((a) => a.name === "Household")!;
    return { app, book, cash, groceries, household };
  }

  async function twoCurrencies() {
    const repo = createMemoryRepository(null);
    const app = createLedgerApp(repo);
    let book = unwrap(await app.createHousehold("USD"));
    const assets = book.accounts.find((a) => a.name === "Assets")!;
    const expenses = book.accounts.find((a) => a.name === "Expenses")!;
    book = unwrap(
      await app.addAccount(book, { parentId: assets.id, name: "USD Card", isPlaceholder: false }),
    );
    book = unwrap(
      await app.addAccount(book, {
        parentId: assets.id,
        name: "EUR Bank",
        isPlaceholder: false,
        currency: "EUR",
      }),
    );
    book = unwrap(
      await app.addAccount(book, {
        parentId: expenses.id,
        name: "EUR Rent",
        isPlaceholder: false,
        currency: "EUR",
      }),
    );
    return {
      app,
      book,
      usdCard: book.accounts.find((a) => a.name === "USD Card")!,
      eurBank: book.accounts.find((a) => a.name === "EUR Bank")!,
      eurRent: book.accounts.find((a) => a.name === "EUR Rent")!,
    };
  }

  it("deleteEntry removes journal row", async () => {
    const { app, book, cash, groceries } = await threeLeaves();
    let next = unwrap(
      await app.addEntry(book, {
        date: "2026-08-10",
        description: "Food",
        fromAccountId: cash.id,
        lines: [{ toAccountId: groceries.id, amount: 4200 }],
      }),
    );
    const id = next.journal.find((e) => e.kind === "standard")!.id;
    next = unwrap(await app.deleteEntry(next, id));
    expect(next.journal.some((e) => e.id === id)).toBe(false);
  });

  it("addEntry with one line posts the same postings as a legacy transfer", async () => {
    const { app, book, cash, groceries } = await threeLeaves();
    const next = unwrap(
      await app.addEntry(book, {
        date: "2026-08-10",
        description: "Food",
        fromAccountId: cash.id,
        lines: [{ toAccountId: groceries.id, amount: 4200 }],
      }),
    );
    const entry = next.journal.find((e) => e.kind === "standard")!;
    expect(entry.postings).toEqual([
      { accountId: groceries.id, side: "debit", amount: 4200 },
      { accountId: cash.id, side: "credit", amount: 4200 },
    ]);
  });

  it("addEntry with multiple lines posts one credit for the total and one debit per line", async () => {
    const { app, book, cash, groceries, household } = await threeLeaves();
    const next = unwrap(
      await app.addEntry(book, {
        date: "2026-08-10",
        description: "Supermarket",
        fromAccountId: cash.id,
        lines: [
          { toAccountId: groceries.id, amount: 40000 },
          { toAccountId: household.id, amount: 10000 },
        ],
      }),
    );
    const entry = next.journal.find((e) => e.kind === "standard")!;
    expect(entry.postings).toEqual([
      { accountId: groceries.id, side: "debit", amount: 40000 },
      { accountId: household.id, side: "debit", amount: 10000 },
      { accountId: cash.id, side: "credit", amount: 50000 },
    ]);
    expect(unwrap(app.balanceOf(next, groceries.id))).toMatchObject({ amount: 40000 });
    expect(unwrap(app.balanceOf(next, household.id))).toMatchObject({ amount: 10000 });
  });

  it("addEntry rejects an empty line list", async () => {
    const { app, book, cash } = await threeLeaves();
    const error = unwrapErr(
      await app.addEntry(book, {
        date: "2026-08-10",
        description: "x",
        fromAccountId: cash.id,
        lines: [],
      }),
    );
    expect(error.code).toBe("ENTRY_TOO_FEW_ACCOUNTS");
  });

  it("addEntry rejects non-integer and non-positive amounts", async () => {
    const { app, book, cash, groceries } = await threeLeaves();
    for (const amount of [10.5, 0, -100]) {
      const error = unwrapErr(
        await app.addEntry(book, {
          date: "2026-08-10",
          description: "x",
          fromAccountId: cash.id,
          lines: [{ toAccountId: groceries.id, amount }],
        }),
      );
      expect(error.code).toBe("ENTRY_AMOUNT_INVALID");
    }
  });

  it("addEntry rejects a line pointing at the From account", async () => {
    const { app, book, cash, groceries } = await threeLeaves();
    const error = unwrapErr(
      await app.addEntry(book, {
        date: "2026-08-10",
        description: "x",
        fromAccountId: cash.id,
        lines: [
          { toAccountId: groceries.id, amount: 100 },
          { toAccountId: cash.id, amount: 200 },
        ],
      }),
    );
    expect(error.code).toBe("ENTRY_TOO_FEW_ACCOUNTS");
  });

  it("addEntry rejects duplicate line accounts", async () => {
    const { app, book, cash, groceries } = await threeLeaves();
    const error = unwrapErr(
      await app.addEntry(book, {
        date: "2026-08-10",
        description: "x",
        fromAccountId: cash.id,
        lines: [
          { toAccountId: groceries.id, amount: 100 },
          { toAccountId: groceries.id, amount: 200 },
        ],
      }),
    );
    expect(error.code).toBe("ENTRY_TOO_FEW_ACCOUNTS");
  });

  it("updateEntry converts a simple entry to a split and back", async () => {
    const { app, book, cash, groceries, household } = await threeLeaves();
    let next = unwrap(
      await app.addEntry(book, {
        date: "2026-08-10",
        description: "Food",
        fromAccountId: cash.id,
        lines: [{ toAccountId: groceries.id, amount: 4200 }],
      }),
    );
    const id = next.journal.find((e) => e.kind === "standard")!.id;

    next = unwrap(
      await app.updateEntry(next, id, {
        date: "2026-08-11",
        description: "Supermarket",
        fromAccountId: cash.id,
        lines: [
          { toAccountId: groceries.id, amount: 3000 },
          { toAccountId: household.id, amount: 1500 },
        ],
      }),
    );
    let entry = next.journal.find((e) => e.id === id)!;
    expect(entry.date).toBe("2026-08-11");
    expect(entry.postings).toHaveLength(3);
    expect(inferEntryLines(entry)).toEqual({
      fromAccountId: cash.id,
      fromAmount: 4500,
      lines: [
        { toAccountId: groceries.id, amount: 3000 },
        { toAccountId: household.id, amount: 1500 },
      ],
      total: 4500,
    });

    next = unwrap(
      await app.updateEntry(next, id, {
        date: "2026-08-11",
        description: "Food",
        fromAccountId: cash.id,
        lines: [{ toAccountId: groceries.id, amount: 4200 }],
      }),
    );
    entry = next.journal.find((e) => e.id === id)!;
    expect(entry.postings).toEqual([
      { accountId: groceries.id, side: "debit", amount: 4200 },
      { accountId: cash.id, side: "credit", amount: 4200 },
    ]);
  });

  it("updateEntry rejects opening entries", async () => {
    const repo = createMemoryRepository(null);
    const app = createLedgerApp(repo);
    let book = unwrap(await app.createHousehold("ILS"));
    const assets = book.accounts.find((a) => a.name === "Assets")!;
    book = unwrap(
      await app.addAccount(book, {
        parentId: assets.id,
        name: "Cash",
        isPlaceholder: false,
        openingAmount: 100,
        openingDate: "2026-08-01",
      }),
    );
    const cash = book.accounts.find((a) => a.name === "Cash")!;
    const error = unwrapErr(
      await app.updateEntry(book, `opening:${cash.id}`, {
        date: "2026-08-01",
        description: "x",
        fromAccountId: cash.id,
        lines: [{ toAccountId: "other", amount: 100 }],
      }),
    );
    expect(error.code).toBe("BOOK_INVALID");
  });

  it("inferEntryLines maps a 2-posting entry to one line", async () => {
    const { app, book, cash, groceries } = await threeLeaves();
    const next = unwrap(
      await app.addEntry(book, {
        date: "2026-08-10",
        description: "Food",
        fromAccountId: cash.id,
        lines: [{ toAccountId: groceries.id, amount: 4200 }],
      }),
    );
    const entry = next.journal.find((e) => e.kind === "standard")!;
    expect(inferEntryLines(entry)).toEqual({
      fromAccountId: cash.id,
      fromAmount: 4200,
      lines: [{ toAccountId: groceries.id, amount: 4200 }],
      total: 4200,
    });
  });

  it("inferEntryLines returns null for multi-credit or unbalanced shapes", () => {
    const base = { id: "x", date: "2026-08-10", description: "", kind: "standard" as const };
    const multiCredit: JournalEntry = {
      ...base,
      postings: [
        { accountId: "a", side: "credit", amount: 100 },
        { accountId: "b", side: "credit", amount: 100 },
        { accountId: "c", side: "debit", amount: 200 },
      ],
    };
    expect(inferEntryLines(multiCredit)).toBeNull();

    const mismatched: JournalEntry = {
      ...base,
      postings: [
        { accountId: "a", side: "credit", amount: 300 },
        { accountId: "c", side: "debit", amount: 200 },
      ],
    };
    expect(inferEntryLines(mismatched)).toBeNull();

    const noDebit: JournalEntry = {
      ...base,
      postings: [{ accountId: "a", side: "credit", amount: 300 }],
    };
    expect(inferEntryLines(noDebit)).toBeNull();
  });

  it("addEntry across currencies stores an fx spec built from both amounts", async () => {
    const { app, book, usdCard, eurBank } = await twoCurrencies();
    const next = unwrap(
      await app.addEntry(book, {
        date: "2026-08-10",
        description: "Wire",
        fromAccountId: usdCard.id,
        fromAmount: 10000,
        lines: [{ toAccountId: eurBank.id, amount: 9240 }],
      }),
    );
    const entry = next.journal.find((e) => e.kind === "standard")!;
    expect(entry.postings).toEqual([
      { accountId: eurBank.id, side: "debit", amount: 9240 },
      { accountId: usdCard.id, side: "credit", amount: 10000 },
    ]);
    expect(entry.fx).toEqual({
      baseCurrency: "USD",
      baseAmount: 10000,
      quoteCurrency: "EUR",
      quoteAmount: 9240,
    });
  });

  it("addEntry across currencies requires fromAmount", async () => {
    const { app, book, usdCard, eurBank } = await twoCurrencies();
    const result = await app.addEntry(book, {
      date: "2026-08-10",
      description: "Wire",
      fromAccountId: usdCard.id,
      lines: [{ toAccountId: eurBank.id, amount: 9240 }],
    });
    expect(unwrapErr(result).code).toBe("ENTRY_AMOUNT_INVALID");
  });

  it("addEntry rejects a cross-currency split", async () => {
    const { app, book, usdCard, eurBank, eurRent } = await twoCurrencies();
    const result = await app.addEntry(book, {
      date: "2026-08-10",
      description: "Wire",
      fromAccountId: usdCard.id,
      fromAmount: 10000,
      lines: [
        { toAccountId: eurBank.id, amount: 5000 },
        { toAccountId: eurRent.id, amount: 4240 },
      ],
    });
    expect(unwrapErr(result).code).toBe("ENTRY_FX_CURRENCY_COUNT");
  });

  it("addEntry rejects lines that disagree in currency", async () => {
    const { app, book, usdCard, eurBank } = await twoCurrencies();
    const assets = book.accounts.find((a) => a.name === "Assets")!;
    const withUsd = unwrap(
      await app.addAccount(book, {
        parentId: assets.id,
        name: "USD Savings",
        isPlaceholder: false,
      }),
    );
    const usdSavings = withUsd.accounts.find((a) => a.name === "USD Savings")!;
    const result = await app.addEntry(withUsd, {
      date: "2026-08-10",
      description: "Mixed",
      fromAccountId: usdCard.id,
      fromAmount: 10000,
      lines: [
        { toAccountId: eurBank.id, amount: 5000 },
        { toAccountId: usdSavings.id, amount: 5000 },
      ],
    });
    expect(unwrapErr(result).code).toBe("ENTRY_FX_CURRENCY_COUNT");
  });

  it("addEntry rejects fromAmount on a same-currency entry", async () => {
    const { app, book, cash, groceries } = await threeLeaves();
    const result = await app.addEntry(book, {
      date: "2026-08-10",
      description: "Food",
      fromAccountId: cash.id,
      fromAmount: 4200,
      lines: [{ toAccountId: groceries.id, amount: 4200 }],
    });
    expect(unwrapErr(result).code).toBe("ENTRY_AMOUNT_INVALID");
  });

  it("addEntry leaves same-currency entries without an fx spec", async () => {
    const { app, book, cash, groceries } = await threeLeaves();
    const next = unwrap(
      await app.addEntry(book, {
        date: "2026-08-10",
        description: "Food",
        fromAccountId: cash.id,
        lines: [{ toAccountId: groceries.id, amount: 4200 }],
      }),
    );
    expect(next.journal.find((e) => e.kind === "standard")!.fx).toBeUndefined();
  });

  it("updateEntry keeps a correct fx spec when the amounts change", async () => {
    const { app, book, usdCard, eurBank } = await twoCurrencies();
    let next = unwrap(
      await app.addEntry(book, {
        date: "2026-08-10",
        description: "Wire",
        fromAccountId: usdCard.id,
        fromAmount: 10000,
        lines: [{ toAccountId: eurBank.id, amount: 9240 }],
      }),
    );
    const id = next.journal.find((e) => e.kind === "standard")!.id;
    next = unwrap(
      await app.updateEntry(next, id, {
        date: "2026-08-11",
        description: "Wire fixed",
        fromAccountId: usdCard.id,
        fromAmount: 20000,
        lines: [{ toAccountId: eurBank.id, amount: 18500 }],
      }),
    );
    expect(next.journal.find((e) => e.id === id)!.fx).toEqual({
      baseCurrency: "USD",
      baseAmount: 20000,
      quoteCurrency: "EUR",
      quoteAmount: 18500,
    });
  });

  it("updateEntry clears fx when the entry becomes same-currency", async () => {
    const { app, book, usdCard, eurBank } = await twoCurrencies();
    const assets = book.accounts.find((a) => a.name === "Assets")!;
    let next = unwrap(
      await app.addAccount(book, { parentId: assets.id, name: "USD Savings", isPlaceholder: false }),
    );
    const usdSavings = next.accounts.find((a) => a.name === "USD Savings")!;
    next = unwrap(
      await app.addEntry(next, {
        date: "2026-08-10",
        description: "Wire",
        fromAccountId: usdCard.id,
        fromAmount: 10000,
        lines: [{ toAccountId: eurBank.id, amount: 9240 }],
      }),
    );
    const id = next.journal.find((e) => e.kind === "standard")!.id;
    next = unwrap(
      await app.updateEntry(next, id, {
        date: "2026-08-10",
        description: "Moved to savings",
        fromAccountId: usdCard.id,
        lines: [{ toAccountId: usdSavings.id, amount: 10000 }],
      }),
    );
    expect(next.journal.find((e) => e.id === id)!.fx).toBeUndefined();
  });

  it("inferEntryLines reads an fx entry with both amounts", async () => {
    const { app, book, usdCard, eurBank } = await twoCurrencies();
    const next = unwrap(
      await app.addEntry(book, {
        date: "2026-08-10",
        description: "Wire",
        fromAccountId: usdCard.id,
        fromAmount: 10000,
        lines: [{ toAccountId: eurBank.id, amount: 9240 }],
      }),
    );
    const entry = next.journal.find((e) => e.kind === "standard")!;
    expect(inferEntryLines(entry)).toEqual({
      fromAccountId: usdCard.id,
      fromAmount: 10000,
      lines: [{ toAccountId: eurBank.id, amount: 9240 }],
      total: 9240,
      fx: {
        baseCurrency: "USD",
        baseAmount: 10000,
        quoteCurrency: "EUR",
        quoteAmount: 9240,
      },
    });
  });

  it("inferEntryLines reports fromAmount equal to the total for same-currency entries", async () => {
    const { app, book, cash, groceries, household } = await threeLeaves();
    const next = unwrap(
      await app.addEntry(book, {
        date: "2026-08-10",
        description: "Shopping",
        fromAccountId: cash.id,
        lines: [
          { toAccountId: groceries.id, amount: 4000 },
          { toAccountId: household.id, amount: 1000 },
        ],
      }),
    );
    const shape = inferEntryLines(next.journal.find((e) => e.kind === "standard")!)!;
    expect(shape.fromAmount).toBe(5000);
    expect(shape.total).toBe(5000);
    expect(shape.fx).toBeUndefined();
  });

  it("inferEntryLines round-trips an fx entry through updateEntry", async () => {
    const { app, book, usdCard, eurBank } = await twoCurrencies();
    let next = unwrap(
      await app.addEntry(book, {
        date: "2026-08-10",
        description: "Wire",
        fromAccountId: usdCard.id,
        fromAmount: 10000,
        lines: [{ toAccountId: eurBank.id, amount: 9240 }],
      }),
    );
    const before = next.journal.find((e) => e.kind === "standard")!;
    const shape = inferEntryLines(before)!;
    next = unwrap(
      await app.updateEntry(next, before.id, {
        date: before.date,
        description: before.description,
        fromAccountId: shape.fromAccountId,
        fromAmount: shape.fromAmount,
        lines: shape.lines,
      }),
    );
    const after = next.journal.find((e) => e.id === before.id)!;
    expect(after.postings).toEqual(before.postings);
    expect(after.fx).toEqual(before.fx);
  });

  it("inferEntryLines rejects an unbalanced entry with no fx spec", () => {
    const entry: JournalEntry = {
      id: "manual",
      date: "2026-08-10",
      description: "Broken",
      kind: "standard",
      postings: [
        { accountId: "a", side: "debit", amount: 900 },
        { accountId: "b", side: "credit", amount: 1000 },
      ],
    };
    expect(inferEntryLines(entry)).toBeNull();
  });

  it("inferEntryLines rejects an fx spec whose amounts do not match the postings", () => {
    const entry: JournalEntry = {
      id: "manual",
      date: "2026-08-10",
      description: "Broken",
      kind: "standard",
      postings: [
        { accountId: "a", side: "debit", amount: 900 },
        { accountId: "b", side: "credit", amount: 1000 },
      ],
      fx: { baseCurrency: "USD", baseAmount: 999, quoteCurrency: "EUR", quoteAmount: 900 },
    };
    expect(inferEntryLines(entry)).toBeNull();
  });
});
