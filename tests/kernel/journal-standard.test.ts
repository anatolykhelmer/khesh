import { createAccount, deleteAccount, updateAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { unwrap, unwrapErr } from "../helpers";
import type { Book } from "../../src/kernel/types";

function twoLeaves(): { book: Book; cashId: string; foodId: string } {
  let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
  book = unwrap(
    createAccount(book, {
      parentId: null,
      name: "Assets",
      type: "asset",
      currency: "ILS",
      isPlaceholder: true,
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
  const assetsId = book.accounts[0].id;
  const expensesId = book.accounts[1].id;
  book = unwrap(
    createAccount(book, {
      parentId: assetsId,
      name: "Cash",
      type: "asset",
      currency: "ILS",
      isPlaceholder: false,
    }),
  );
  book = unwrap(
    createAccount(book, {
      parentId: expensesId,
      name: "Food",
      type: "expense",
      currency: "ILS",
      isPlaceholder: false,
    }),
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
      }),
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
      }),
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
      }),
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
        }),
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
        }),
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
        }),
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
        }),
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
        }),
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
        }),
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
      }),
    );
    expect(unwrapErr(updateAccount(posted, { id: cashId, currency: "USD" })).code).toBe(
      "ACCOUNT_CURRENCY_LOCKED",
    );
    expect(unwrapErr(deleteAccount(posted, cashId)).code).toBe("ACCOUNT_HAS_POSTINGS");
  });
});
