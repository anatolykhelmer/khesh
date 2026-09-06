import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { NOW, unwrap, unwrapErr } from "../helpers";
import type { Book } from "../../src/kernel/types";

function ilsAndUsd(): { book: Book; cashIls: string; revolutUsd: string; foodIls: string } {
  let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
  book = unwrap(
    createAccount(book, {
      parentId: null,
      name: "Assets",
      type: "asset",
      currency: "ILS",
      isPlaceholder: true,
    }, NOW),
  );
  book = unwrap(
    createAccount(book, {
      parentId: null,
      name: "Expenses",
      type: "expense",
      currency: "ILS",
      isPlaceholder: true,
    }, NOW),
  );
  const assets = book.accounts[0].id;
  const expenses = book.accounts[1].id;
  book = unwrap(
    createAccount(book, {
      parentId: assets,
      name: "Cash ILS",
      type: "asset",
      currency: "ILS",
      isPlaceholder: false,
    }, NOW),
  );
  book = unwrap(
    createAccount(book, {
      parentId: assets,
      name: "Revolut",
      type: "asset",
      currency: "USD",
      isPlaceholder: false,
    }, NOW),
  );
  book = unwrap(
    createAccount(book, {
      parentId: expenses,
      name: "Food",
      type: "expense",
      currency: "ILS",
      isPlaceholder: false,
    }, NOW),
  );
  return {
    book,
    cashIls: book.accounts[2].id,
    revolutUsd: book.accounts[3].id,
    foodIls: book.accounts[4].id,
  };
}

describe("postEntry FX B1", () => {
  it("accepts two currencies that do not internally balance", () => {
    const { book, revolutUsd, foodIls } = ilsAndUsd();
    const next = unwrap(
      postEntry(book, {
        date: "2026-02-01",
        description: "Coffee USD",
        postings: [
          { accountId: foodIls, side: "debit", amount: 4400 },
          { accountId: revolutUsd, side: "credit", amount: 1200 },
        ],
      }, NOW),
    );
    expect(next.journal).toHaveLength(1);
  });

  it("accepts omitted fx on two-currency entry", () => {
    const { book, cashIls, revolutUsd } = ilsAndUsd();
    const next = unwrap(
      postEntry(book, {
        date: "2026-02-01",
        description: "Buy USD",
        postings: [
          { accountId: revolutUsd, side: "debit", amount: 10000 },
          { accountId: cashIls, side: "credit", amount: 37000 },
        ],
      }, NOW),
    );
    expect(next.journal[0].fx).toBeUndefined();
  });

  it("accepts matching fx spec", () => {
    const { book, cashIls, revolutUsd } = ilsAndUsd();
    const next = unwrap(
      postEntry(book, {
        date: "2026-02-01",
        description: "Buy USD",
        postings: [
          { accountId: revolutUsd, side: "debit", amount: 10000 },
          { accountId: cashIls, side: "credit", amount: 37000 },
        ],
        fx: {
          baseCurrency: "USD",
          quoteCurrency: "ILS",
          baseAmount: 10000,
          quoteAmount: 37000,
        },
      }, NOW),
    );
    expect(next.journal[0].fx?.quoteAmount).toBe(37000);
  });

  it("rejects fx amount mismatch", () => {
    const { book, cashIls, revolutUsd } = ilsAndUsd();
    expect(
      unwrapErr(
        postEntry(book, {
          date: "2026-02-01",
          description: "Buy USD",
          postings: [
            { accountId: revolutUsd, side: "debit", amount: 10000 },
            { accountId: cashIls, side: "credit", amount: 37000 },
          ],
          fx: {
            baseCurrency: "USD",
            quoteCurrency: "ILS",
            baseAmount: 10000,
            quoteAmount: 1,
          },
        }, NOW),
      ).code,
    ).toBe("ENTRY_FX_RATE_MISMATCH");
  });

  it("rejects fx on a one-currency entry", () => {
    const { book, cashIls, foodIls } = ilsAndUsd();
    expect(
      unwrapErr(
        postEntry(book, {
          date: "2026-02-01",
          description: "Food",
          postings: [
            { accountId: foodIls, side: "debit", amount: 100 },
            { accountId: cashIls, side: "credit", amount: 100 },
          ],
          fx: {
            baseCurrency: "ILS",
            quoteCurrency: "USD",
            baseAmount: 100,
            quoteAmount: 100,
          },
        }, NOW),
      ).code,
    ).toBe("ENTRY_FX_CURRENCY_COUNT");
  });

  it("rejects three currencies", () => {
    const { book, cashIls, revolutUsd, foodIls } = ilsAndUsd();
    let next = unwrap(
      createAccount(book, {
        parentId: book.accounts[0].id,
        name: "EUR cash",
        type: "asset",
        currency: "EUR",
        isPlaceholder: false,
      }, NOW),
    );
    const eurId = next.accounts[5].id;
    expect(
      unwrapErr(
        postEntry(next, {
          date: "2026-02-01",
          description: "Triple",
          postings: [
            { accountId: foodIls, side: "debit", amount: 100 },
            { accountId: cashIls, side: "credit", amount: 50 },
            { accountId: revolutUsd, side: "credit", amount: 10 },
            { accountId: eurId, side: "credit", amount: 10 },
          ],
        }, NOW),
      ).code,
    ).toBe("ENTRY_FX_CURRENCY_COUNT");
  });
});
