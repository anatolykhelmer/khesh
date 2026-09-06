import { createAccount, deleteAccount, updateAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { NOW, unwrap, unwrapErr } from "../helpers";
import type { Book } from "../../src/kernel/types";

function twoLeaves(): { book: Book; cashId: string; foodId: string } {
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
  const assetsId = book.accounts[0].id;
  const expensesId = book.accounts[1].id;
  book = unwrap(
    createAccount(book, {
      parentId: assetsId,
      name: "Cash",
      type: "asset",
      currency: "ILS",
      isPlaceholder: false,
    }, NOW),
  );
  book = unwrap(
    createAccount(book, {
      parentId: expensesId,
      name: "Food",
      type: "expense",
      currency: "ILS",
      isPlaceholder: false,
    }, NOW),
  );
  return {
    book,
    cashId: book.accounts[2].id,
    foodId: book.accounts[3].id,
  };
}

describe("postEntry same-currency", () => {
  it("posts a balanced two-split entry", () => {
    const { book, cashId, foodId } = twoLeaves();
    const next = unwrap(
      postEntry(book, {
        date: "2026-01-15",
        description: "Groceries",
        postings: [
          { accountId: foodId, side: "debit", amount: 8000 },
          { accountId: cashId, side: "credit", amount: 8000 },
        ],
      }, NOW),
    );
    expect(next.journal).toHaveLength(1);
    expect(next.journal[0].kind).toBe("standard");
    expect(next.journal[0].description).toBe("Groceries");
    expect(book.journal).toHaveLength(0);
  });

  it("posts a balanced three-split entry", () => {
    const { book, cashId, foodId } = twoLeaves();
    let next = unwrap(
      createAccount(book, {
        parentId: book.accounts[1].id,
        name: "Fees",
        type: "expense",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    const feesId = next.accounts[4].id;
    next = unwrap(
      postEntry(next, {
        date: "2026-01-15",
        description: "Shop + fee",
        postings: [
          { accountId: foodId, side: "debit", amount: 7800 },
          { accountId: feesId, side: "debit", amount: 200 },
          { accountId: cashId, side: "credit", amount: 8000 },
        ],
      }, NOW),
    );
    expect(next.journal[0].postings).toHaveLength(3);
  });

  it("rejects unbalanced entry", () => {
    const { book, cashId, foodId } = twoLeaves();
    expect(
      unwrapErr(
        postEntry(book, {
          date: "2026-01-15",
          description: "Bad",
          postings: [
            { accountId: foodId, side: "debit", amount: 8000 },
            { accountId: cashId, side: "credit", amount: 7000 },
          ],
        }, NOW),
      ).code,
    ).toBe("ENTRY_UNBALANCED");
  });

  it("rejects non-positive amount", () => {
    const { book, cashId, foodId } = twoLeaves();
    expect(
      unwrapErr(
        postEntry(book, {
          date: "2026-01-15",
          description: "Bad",
          postings: [
            { accountId: foodId, side: "debit", amount: 0 },
            { accountId: cashId, side: "credit", amount: 0 },
          ],
        }, NOW),
      ).code,
    ).toBe("ENTRY_AMOUNT_INVALID");
  });

  it("rejects one distinct account", () => {
    const { book, cashId } = twoLeaves();
    expect(
      unwrapErr(
        postEntry(book, {
          date: "2026-01-15",
          description: "Self",
          postings: [
            { accountId: cashId, side: "debit", amount: 100 },
            { accountId: cashId, side: "credit", amount: 100 },
          ],
        }, NOW),
      ).code,
    ).toBe("ENTRY_TOO_FEW_ACCOUNTS");
  });

  it("rejects posting to placeholder", () => {
    const { book, cashId } = twoLeaves();
    expect(
      unwrapErr(
        postEntry(book, {
          date: "2026-01-15",
          description: "Bad",
          postings: [
            { accountId: book.accounts[0].id, side: "debit", amount: 100 },
            { accountId: cashId, side: "credit", amount: 100 },
          ],
        }, NOW),
      ).code,
    ).toBe("ACCOUNT_IS_PLACEHOLDER");
  });

  it("rejects invalid date", () => {
    const { book, cashId, foodId } = twoLeaves();
    expect(
      unwrapErr(
        postEntry(book, {
          date: "2026-13-40",
          description: "Bad",
          postings: [
            { accountId: foodId, side: "debit", amount: 100 },
            { accountId: cashId, side: "credit", amount: 100 },
          ],
        }, NOW),
      ).code,
    ).toBe("ENTRY_DATE_INVALID");
  });

  it("rejects fewer than two postings", () => {
    const { book, cashId } = twoLeaves();
    expect(
      unwrapErr(
        postEntry(book, {
          date: "2026-01-15",
          description: "Bad",
          postings: [{ accountId: cashId, side: "debit", amount: 100 }],
        }, NOW),
      ).code,
    ).toBe("ENTRY_TOO_FEW_POSTINGS");
  });

  it("locks currency after postings", () => {
    const { book, cashId, foodId } = twoLeaves();
    const posted = unwrap(
      postEntry(book, {
        date: "2026-01-15",
        description: "Groceries",
        postings: [
          { accountId: foodId, side: "debit", amount: 100 },
          { accountId: cashId, side: "credit", amount: 100 },
        ],
      }, NOW),
    );
    expect(unwrapErr(updateAccount(posted, { id: cashId, currency: "USD" }, NOW)).code).toBe(
      "ACCOUNT_CURRENCY_LOCKED",
    );
    expect(unwrapErr(deleteAccount(posted, cashId, NOW)).code).toBe("ACCOUNT_HAS_POSTINGS");
  });
});
