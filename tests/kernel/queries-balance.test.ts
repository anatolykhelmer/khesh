import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { recordOpeningBalance } from "../../src/kernel/opening";
import { accountPath, balance, balanceAsOf, chart } from "../../src/kernel/queries";
import { NOW, unwrap, unwrapErr } from "../helpers";

describe("queries: path, chart, balance", () => {
  it("builds accountPath and chart tree", () => {
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
        parentId: book.accounts[0].id,
        name: "Bank",
        type: "asset",
        currency: "ILS",
        isPlaceholder: true,
      }, NOW),
    );
    book = unwrap(
      createAccount(book, {
        parentId: book.accounts[1].id,
        name: "Leumi",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    expect(unwrap(accountPath(book, book.accounts[2].id))).toBe("Assets:Bank:Leumi");
    const tree = unwrap(chart(book));
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("Assets");
    expect(tree[0].children[0].name).toBe("Bank");
    expect(tree[0].children[0].children[0].name).toBe("Leumi");
  });

  it("shows positive liability debt", () => {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Card",
        type: "liability",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Food",
        type: "expense",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    book = unwrap(
      postEntry(book, {
        date: "2026-03-01",
        description: "Spend",
        postings: [
          { accountId: book.accounts[1].id, side: "debit", amount: 5000 },
          { accountId: book.accounts[0].id, side: "credit", amount: 5000 },
        ],
      }, NOW),
    );
    expect(unwrap(balance(book, book.accounts[0].id))).toEqual({
      kind: "leaf",
      currency: "ILS",
      amount: 5000,
    });
  });

  it("balanceAsOf excludes later dates", () => {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    const cashId = book.accounts[0].id;
    book = unwrap(recordOpeningBalance(book, { accountId: cashId, amount: 10000, date: "2026-01-01" }, NOW));
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Food",
        type: "expense",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    const foodId = book.accounts.find((a) => a.name === "Food")!.id;
    book = unwrap(
      postEntry(book, {
        date: "2026-03-01",
        description: "Spend",
        postings: [
          { accountId: foodId, side: "debit", amount: 2000 },
          { accountId: cashId, side: "credit", amount: 2000 },
        ],
      }, NOW),
    );
    expect(unwrap(balanceAsOf(book, cashId, "2026-02-01"))).toEqual({
      kind: "leaf",
      currency: "ILS",
      amount: 10000,
    });
    expect(unwrap(balance(book, cashId))).toEqual({
      kind: "leaf",
      currency: "ILS",
      amount: 8000,
    });
  });

  it("placeholder balance is a currency map", () => {
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
    const assetsId = book.accounts[0].id;
    book = unwrap(
      createAccount(book, {
        parentId: assetsId,
        name: "ILS cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    book = unwrap(
      createAccount(book, {
        parentId: assetsId,
        name: "USD cash",
        type: "asset",
        currency: "USD",
        isPlaceholder: false,
      }, NOW),
    );
    const ilsId = book.accounts[1].id;
    const usdId = book.accounts[2].id;
    book = unwrap(recordOpeningBalance(book, { accountId: ilsId, amount: 100, date: "2026-01-01" }, NOW));
    book = unwrap(recordOpeningBalance(book, { accountId: usdId, amount: 50, date: "2026-01-01" }, NOW));
    expect(unwrap(balance(book, assetsId))).toEqual({
      kind: "placeholder",
      balances: { ILS: 100, USD: 50 },
    });
  });

  it("rejects unknown account and bad asOf", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    expect(unwrapErr(balance(book, "nope")).code).toBe("ACCOUNT_NOT_FOUND");
    expect(unwrapErr(accountPath(book, "nope")).code).toBe("ACCOUNT_NOT_FOUND");
    let withCash = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    expect(unwrapErr(balanceAsOf(withCash, withCash.accounts[0].id, "bad")).code).toBe(
      "ENTRY_DATE_INVALID",
    );
  });
});
