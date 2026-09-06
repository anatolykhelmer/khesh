import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { deleteEntry, postEntry, updateEntry } from "../../src/kernel/journal";
import { NOW, unwrap, unwrapErr } from "../helpers";

function posted() {
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
  book = unwrap(
    createAccount(book, {
      parentId: null,
      name: "Food",
      type: "expense",
      currency: "ILS",
      isPlaceholder: false,
    }, NOW),
  );
  const cashId = book.accounts[0].id;
  const foodId = book.accounts[1].id;
  book = unwrap(
    postEntry(book, {
      date: "2026-01-10",
      description: "Groceries",
      postings: [
        { accountId: foodId, side: "debit", amount: 5000 },
        { accountId: cashId, side: "credit", amount: 5000 },
      ],
    }, NOW),
  );
  return { book, cashId, foodId, entryId: book.journal[0].id };
}

describe("updateEntry / deleteEntry", () => {
  it("updates description and amount then recomputes journal", () => {
    const { book, cashId, foodId, entryId } = posted();
    const next = unwrap(
      updateEntry(book, {
        id: entryId,
        description: "Fixed",
        postings: [
          { accountId: foodId, side: "debit", amount: 6000 },
          { accountId: cashId, side: "credit", amount: 6000 },
        ],
      }, NOW),
    );
    expect(next.journal[0].description).toBe("Fixed");
    expect(next.journal[0].postings[0].amount).toBe(6000);
    expect(next.journal[0].kind).toBe("standard");
  });

  it("rejects unbalanced update", () => {
    const { book, cashId, foodId, entryId } = posted();
    expect(
      unwrapErr(
        updateEntry(book, {
          id: entryId,
          postings: [
            { accountId: foodId, side: "debit", amount: 6000 },
            { accountId: cashId, side: "credit", amount: 1 },
          ],
        }, NOW),
      ).code,
    ).toBe("ENTRY_UNBALANCED");
  });

  it("rejects unknown id", () => {
    const { book } = posted();
    expect(unwrapErr(updateEntry(book, { id: "nope", description: "X" }, NOW)).code).toBe(
      "ENTRY_NOT_FOUND",
    );
    expect(unwrapErr(deleteEntry(book, "nope", NOW)).code).toBe("ENTRY_NOT_FOUND");
  });

  it("deletes an entry", () => {
    const { book, entryId } = posted();
    const next = unwrap(deleteEntry(book, entryId, NOW));
    expect(next.journal).toHaveLength(0);
    expect(book.journal).toHaveLength(1);
  });

  it("clears fx when fx is null", () => {
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
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "USD",
        type: "asset",
        currency: "USD",
        isPlaceholder: false,
      }, NOW),
    );
    book = unwrap(
      postEntry(book, {
        date: "2026-01-10",
        description: "FX",
        postings: [
          { accountId: book.accounts[1].id, side: "debit", amount: 100 },
          { accountId: book.accounts[0].id, side: "credit", amount: 370 },
        ],
        fx: {
          baseCurrency: "USD",
          quoteCurrency: "ILS",
          baseAmount: 100,
          quoteAmount: 370,
        },
      }, NOW),
    );
    const next = unwrap(updateEntry(book, { id: book.journal[0].id, fx: null }, NOW));
    expect(next.journal[0].fx).toBeUndefined();
  });
});
