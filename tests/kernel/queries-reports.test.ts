import { createAccount } from "../../src/kernel/accounts";
import { postEntry } from "../../src/kernel/journal";
import { journal, trialBalance } from "../../src/kernel/queries";
import { NOW, unwrap, unwrapErr } from "../helpers";
import { accountNamed, realBook, ROOT } from "../helpers/book";

describe("trialBalance and journal", () => {
  it("same-currency trial balance totals match", () => {
    let book = realBook();
    book = unwrap(
      createAccount(book, {
        parentId: ROOT.asset,
        name: "Cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    book = unwrap(
      createAccount(book, {
        parentId: ROOT.expense,
        name: "Food",
        type: "expense",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    const cash = accountNamed(book, "Cash").id;
    const food = accountNamed(book, "Food").id;
    book = unwrap(
      postEntry(book, {
        date: "2026-04-01",
        description: "Food",
        postings: [
          { accountId: food, side: "debit", amount: 3000 },
          { accountId: cash, side: "credit", amount: 3000 },
        ],
      }, NOW),
    );
    const tb = unwrap(trialBalance(book));
    expect(tb.asOf).toBeNull();
    expect(tb.byCurrency.ILS.debitTotal).toBe(tb.byCurrency.ILS.creditTotal);
    expect(tb.byCurrency.ILS.debitTotal).toBe(3000);
    expect(tb.byCurrency.ILS.rows).toHaveLength(2);
  });

  it("FX trial balance totals may differ", () => {
    let book = realBook();
    book = unwrap(
      createAccount(book, {
        parentId: ROOT.asset,
        name: "Cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    book = unwrap(
      createAccount(book, {
        parentId: ROOT.asset,
        name: "USD",
        type: "asset",
        currency: "USD",
        isPlaceholder: false,
      }, NOW),
    );
    const cash = accountNamed(book, "Cash").id;
    const usd = accountNamed(book, "USD").id;
    book = unwrap(
      postEntry(book, {
        date: "2026-04-01",
        description: "FX",
        postings: [
          { accountId: usd, side: "debit", amount: 10000 },
          { accountId: cash, side: "credit", amount: 37000 },
        ],
      }, NOW),
    );
    const tb = unwrap(trialBalance(book));
    expect(tb.byCurrency.ILS.debitTotal).not.toBe(tb.byCurrency.ILS.creditTotal);
    expect(tb.byCurrency.USD.debitTotal).not.toBe(tb.byCurrency.USD.creditTotal);
  });

  it("filters journal by date and account", () => {
    let book = realBook();
    book = unwrap(
      createAccount(book, {
        parentId: ROOT.asset,
        name: "Cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    book = unwrap(
      createAccount(book, {
        parentId: ROOT.expense,
        name: "Food",
        type: "expense",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    book = unwrap(
      createAccount(book, {
        parentId: ROOT.expense,
        name: "Rent",
        type: "expense",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    const cash = accountNamed(book, "Cash").id;
    const food = accountNamed(book, "Food").id;
    const rent = accountNamed(book, "Rent").id;
    book = unwrap(
      postEntry(book, {
        date: "2026-01-01",
        description: "A",
        postings: [
          { accountId: food, side: "debit", amount: 1 },
          { accountId: cash, side: "credit", amount: 1 },
        ],
      }, NOW),
    );
    book = unwrap(
      postEntry(book, {
        date: "2026-03-01",
        description: "B",
        postings: [
          { accountId: rent, side: "debit", amount: 2 },
          { accountId: cash, side: "credit", amount: 2 },
        ],
      }, NOW),
    );
    const listed = unwrap(journal(book, { from: "2026-02-01", to: "2026-12-31", accountId: rent }));
    expect(listed).toHaveLength(1);
    expect(listed[0].description).toBe("B");
    const newestFirst = unwrap(journal(book));
    expect(newestFirst[0].date >= newestFirst[1].date).toBe(true);
  });

  it("rejects invalid journal filter dates", () => {
    const book = realBook();
    expect(unwrapErr(journal(book, { from: "nope" })).code).toBe("ENTRY_DATE_INVALID");
  });

  it("filtering by a group covers its whole subtree", () => {
    let book = realBook();
    book = unwrap(
      createAccount(book, {
        parentId: ROOT.asset,
        name: "Cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    const cash = accountNamed(book, "Cash").id;
    const expenses = ROOT.expense;
    book = unwrap(
      createAccount(book, {
        parentId: expenses,
        name: "Home",
        type: "expense",
        currency: "ILS",
        isPlaceholder: true,
      }, NOW),
    );
    const home = accountNamed(book, "Home").id;
    book = unwrap(
      createAccount(book, {
        parentId: home,
        name: "Rent",
        type: "expense",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    const rent = accountNamed(book, "Rent").id;
    const income = ROOT.income;
    book = unwrap(
      postEntry(book, {
        date: "2026-01-01",
        description: "Rent",
        postings: [
          { accountId: rent, side: "debit", amount: 100 },
          { accountId: cash, side: "credit", amount: 100 },
        ],
      }, NOW),
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
