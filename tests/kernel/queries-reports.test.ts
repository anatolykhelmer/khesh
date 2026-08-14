import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { journal, trialBalance } from "../../src/kernel/queries";
import { unwrap, unwrapErr } from "../helpers";

describe("trialBalance and journal", () => {
  it("same-currency trial balance totals match", () => {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }),
    );
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Food",
        type: "expense",
        currency: "ILS",
        isPlaceholder: false,
      }),
    );
    book = unwrap(
      postEntry(book, {
        date: "2026-04-01",
        description: "Food",
        postings: [
          { accountId: book.accounts[1].id, side: "debit", amount: 3000 },
          { accountId: book.accounts[0].id, side: "credit", amount: 3000 },
        ],
      }),
    );
    const tb = unwrap(trialBalance(book));
    expect(tb.asOf).toBeNull();
    expect(tb.byCurrency.ILS.debitTotal).toBe(tb.byCurrency.ILS.creditTotal);
    expect(tb.byCurrency.ILS.debitTotal).toBe(3000);
    expect(tb.byCurrency.ILS.rows).toHaveLength(2);
  });

  it("FX trial balance totals may differ", () => {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }),
    );
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "USD",
        type: "asset",
        currency: "USD",
        isPlaceholder: false,
      }),
    );
    book = unwrap(
      postEntry(book, {
        date: "2026-04-01",
        description: "FX",
        postings: [
          { accountId: book.accounts[1].id, side: "debit", amount: 10000 },
          { accountId: book.accounts[0].id, side: "credit", amount: 37000 },
        ],
      }),
    );
    const tb = unwrap(trialBalance(book));
    expect(tb.byCurrency.ILS.debitTotal).not.toBe(tb.byCurrency.ILS.creditTotal);
    expect(tb.byCurrency.USD.debitTotal).not.toBe(tb.byCurrency.USD.creditTotal);
  });

  it("filters journal by date and account", () => {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }),
    );
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Food",
        type: "expense",
        currency: "ILS",
        isPlaceholder: false,
      }),
    );
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Rent",
        type: "expense",
        currency: "ILS",
        isPlaceholder: false,
      }),
    );
    const cash = book.accounts[0].id;
    const food = book.accounts[1].id;
    const rent = book.accounts[2].id;
    book = unwrap(
      postEntry(book, {
        date: "2026-01-01",
        description: "A",
        postings: [
          { accountId: food, side: "debit", amount: 1 },
          { accountId: cash, side: "credit", amount: 1 },
        ],
      }),
    );
    book = unwrap(
      postEntry(book, {
        date: "2026-03-01",
        description: "B",
        postings: [
          { accountId: rent, side: "debit", amount: 2 },
          { accountId: cash, side: "credit", amount: 2 },
        ],
      }),
    );
    const listed = unwrap(journal(book, { from: "2026-02-01", to: "2026-12-31", accountId: rent }));
    expect(listed).toHaveLength(1);
    expect(listed[0].description).toBe("B");
    const newestFirst = unwrap(journal(book));
    expect(newestFirst[0].date >= newestFirst[1].date).toBe(true);
  });

  it("rejects invalid journal filter dates", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
    expect(unwrapErr(journal(book, { from: "nope" })).code).toBe("ENTRY_DATE_INVALID");
  });

  it("filtering by a group covers its whole subtree", () => {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }),
    );
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Expenses",
        type: "expense",
        currency: "ILS",
        isPlaceholder: true,
      }),
    );
    const cash = book.accounts[0].id;
    const expenses = book.accounts[1].id;
    book = unwrap(
      createAccount(book, {
        parentId: expenses,
        name: "Home",
        type: "expense",
        currency: "ILS",
        isPlaceholder: true,
      }),
    );
    const home = book.accounts[2].id;
    book = unwrap(
      createAccount(book, {
        parentId: home,
        name: "Rent",
        type: "expense",
        currency: "ILS",
        isPlaceholder: false,
      }),
    );
    const rent = book.accounts[3].id;
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Income",
        type: "income",
        currency: "ILS",
        isPlaceholder: true,
      }),
    );
    const income = book.accounts[4].id;
    book = unwrap(
      postEntry(book, {
        date: "2026-01-01",
        description: "Rent",
        postings: [
          { accountId: rent, side: "debit", amount: 100 },
          { accountId: cash, side: "credit", amount: 100 },
        ],
      }),
    );

    // Two levels above the posting, and one level above.
    expect(unwrap(journal(book, { accountId: expenses }))).toHaveLength(1);
    expect(unwrap(journal(book, { accountId: home }))).toHaveLength(1);
    // The leaf itself keeps working exactly as before.
    expect(unwrap(journal(book, { accountId: rent }))).toHaveLength(1);
    // A group with nothing beneath it must not sweep in unrelated entries.
    expect(unwrap(journal(book, { accountId: income }))).toHaveLength(0);
    // Widening the match must not weaken the existence check.
    expect(unwrapErr(journal(book, { accountId: "nope" })).code).toBe("ACCOUNT_NOT_FOUND");
  });
});
