import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { updateEntry } from "../../src/kernel/journal";
import { recordOpeningBalance } from "../../src/kernel/opening";
import { unwrap, unwrapErr } from "../helpers";

describe("recordOpeningBalance", () => {
  it("creates system OB accounts and an opening entry", () => {
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
    const cashId = book.accounts[0].id;
    book = unwrap(recordOpeningBalance(book, { accountId: cashId, amount: 10000, date: "2026-01-01" }));

    expect(book.accounts.some((a) => a.id === "sys:ob" && a.isPlaceholder)).toBe(true);
    expect(book.accounts.some((a) => a.id === "sys:ob:ILS" && a.type === "equity")).toBe(true);
    const entry = book.journal.find((e) => e.id === `opening:${cashId}`);
    expect(entry?.kind).toBe("opening");
    expect(entry?.description).toBe("Opening balance");
    expect(entry?.postings).toEqual([
      { accountId: cashId, side: "debit", amount: 10000 },
      { accountId: "sys:ob:ILS", side: "credit", amount: 10000 },
    ]);
  });

  it("uses credit on a liability target", () => {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Card",
        type: "liability",
        currency: "ILS",
        isPlaceholder: false,
      }),
    );
    book = unwrap(
      recordOpeningBalance(book, {
        accountId: book.accounts[0].id,
        amount: 5000,
        date: "2026-01-01",
      }),
    );
    expect(book.journal[0].postings[0].side).toBe("credit");
  });

  it("upserts by opening:{accountId}", () => {
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
    const cashId = book.accounts[0].id;
    book = unwrap(recordOpeningBalance(book, { accountId: cashId, amount: 100, date: "2026-01-01" }));
    book = unwrap(recordOpeningBalance(book, { accountId: cashId, amount: 200, date: "2026-01-02" }));
    expect(book.journal).toHaveLength(1);
    expect(book.journal[0].date).toBe("2026-01-02");
    expect(book.journal[0].postings[0].amount).toBe(200);
  });

  it("amount 0 removes the opening entry", () => {
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
    const cashId = book.accounts[0].id;
    book = unwrap(recordOpeningBalance(book, { accountId: cashId, amount: 100, date: "2026-01-01" }));
    book = unwrap(recordOpeningBalance(book, { accountId: cashId, amount: 0, date: "2026-01-01" }));
    expect(book.journal).toHaveLength(0);
  });

  it("rejects system OB target", () => {
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
      recordOpeningBalance(book, {
        accountId: book.accounts[0].id,
        amount: 100,
        date: "2026-01-01",
      }),
    );
    expect(
      unwrapErr(recordOpeningBalance(book, { accountId: "sys:ob", amount: 1, date: "2026-01-01" }))
        .code,
    ).toBe("ACCOUNT_IS_SYSTEM");
    expect(
      unwrapErr(
        recordOpeningBalance(book, { accountId: "sys:ob:ILS", amount: 1, date: "2026-01-01" }),
      ).code,
    ).toBe("ACCOUNT_IS_SYSTEM");
  });

  it("fails when a root account is already named Opening Balances", () => {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Opening Balances",
        type: "equity",
        currency: "ILS",
        isPlaceholder: true,
      }),
    );
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }),
    );
    const cashId = book.accounts.find((account) => account.name === "Cash")!.id;
    const snapshot = structuredClone(book);

    const error = unwrapErr(
      recordOpeningBalance(book, { accountId: cashId, amount: 100, date: "2026-01-01" }),
    );
    expect(error.code).toBe("ACCOUNT_NAME_DUPLICATE");
    expect(book).toEqual(snapshot);
    expect(book.accounts.some((account) => account.id === "sys:ob")).toBe(false);
  });

  it("fails when sys:ob already has a non-system child named for the currency", () => {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
    book.accounts.push({
      id: "sys:ob",
      parentId: null,
      name: "Opening Balances",
      type: "equity",
      currency: "ILS",
      isPlaceholder: true,
    });
    book.accounts.push({
      id: "user-ils",
      parentId: "sys:ob",
      name: "ILS",
      type: "equity",
      currency: "ILS",
      isPlaceholder: false,
    });
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }),
    );
    const cashId = book.accounts.find((account) => account.name === "Cash")!.id;
    const snapshot = structuredClone(book);

    const error = unwrapErr(
      recordOpeningBalance(book, { accountId: cashId, amount: 100, date: "2026-01-01" }),
    );
    expect(error.code).toBe("ACCOUNT_NAME_DUPLICATE");
    expect(book).toEqual(snapshot);
    expect(book.accounts.some((account) => account.id === "sys:ob:ILS")).toBe(false);
  });

  it("keeps kind opening on updateEntry and rejects FX opening", () => {
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
    const cashId = book.accounts[0].id;
    const usdId = book.accounts[1].id;
    book = unwrap(recordOpeningBalance(book, { accountId: cashId, amount: 100, date: "2026-01-01" }));
    expect(
      unwrapErr(
        updateEntry(book, {
          id: `opening:${cashId}`,
          postings: [
            { accountId: cashId, side: "debit", amount: 100 },
            { accountId: usdId, side: "credit", amount: 30 },
          ],
        }),
      ).code,
    ).toBe("ENTRY_OPENING_MUST_BE_SINGLE_CURRENCY");
  });
});
