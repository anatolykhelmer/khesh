import { createAccount, deleteAccount, updateAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { createRecurrence } from "../../src/kernel/recurrences";
import { validateBook } from "../../src/kernel/validate";
import { NOW, unwrap, unwrapErr } from "../helpers";
import type { Book } from "../../src/kernel/types";

function bookWithAssets(): { book: Book; assetsId: string; cashId: string } {
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
      name: "Cash",
      type: "asset",
      currency: "ILS",
      isPlaceholder: false,
    }, NOW),
  );
  const cashId = book.accounts[1].id;
  return { book, assetsId, cashId };
}

describe("updateAccount", () => {
  it("renames an account", () => {
    const { book, cashId } = bookWithAssets();
    const next = unwrap(updateAccount(book, { id: cashId, name: " Wallet " }, NOW));
    expect(next.accounts.find((a) => a.id === cashId)?.name).toBe("Wallet");
  });

  it("rejects unknown id", () => {
    const { book } = bookWithAssets();
    expect(unwrapErr(updateAccount(book, { id: "nope", name: "X" }, NOW)).code).toBe(
      "ACCOUNT_NOT_FOUND",
    );
  });

  it("rejects duplicate sibling name", () => {
    const { book, assetsId, cashId } = bookWithAssets();
    const withBank = unwrap(
      createAccount(book, {
        parentId: assetsId,
        name: "Bank",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    expect(
      unwrapErr(updateAccount(withBank, { id: cashId, name: "Bank" }, NOW)).code,
    ).toBe("ACCOUNT_NAME_DUPLICATE");
  });

  it("rejects cycle", () => {
    const { book, assetsId } = bookWithAssets();
    expect(
      unwrapErr(updateAccount(book, { id: assetsId, parentId: book.accounts[1].id }, NOW)).code,
    ).toBe("ACCOUNT_CYCLE");
  });

  it("rejects type change when account has children", () => {
    const { book, assetsId } = bookWithAssets();
    expect(unwrapErr(updateAccount(book, { id: assetsId, type: "liability" }, NOW)).code).toBe(
      "ACCOUNT_HAS_CHILDREN",
    );
  });

  it("allows type/currency change on a posting-free leaf", () => {
    const { book, cashId } = bookWithAssets();
    const next = unwrap(updateAccount(book, { id: cashId, type: "asset", currency: "USD" }, NOW));
    expect(next.accounts.find((a) => a.id === cashId)?.currency).toBe("USD");
  });

  it("rejects turning placeholder off when it has children", () => {
    const { book, assetsId } = bookWithAssets();
    expect(
      unwrapErr(updateAccount(book, { id: assetsId, isPlaceholder: false }, NOW)).code,
    ).toBe("ACCOUNT_HAS_CHILDREN");
  });
});

describe("deleteAccount", () => {
  it("deletes a leaf with no postings", () => {
    const { book, cashId } = bookWithAssets();
    const next = unwrap(deleteAccount(book, cashId, NOW));
    expect(next.accounts.find((a) => a.id === cashId)).toBeUndefined();
  });

  it("rejects deleting a parent with children", () => {
    const { book, assetsId } = bookWithAssets();
    expect(unwrapErr(deleteAccount(book, assetsId, NOW)).code).toBe("ACCOUNT_HAS_CHILDREN");
  });

  it("rejects unknown id", () => {
    const { book } = bookWithAssets();
    expect(unwrapErr(deleteAccount(book, "nope", NOW)).code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("takes with it any rule that posts to the deleted account, leaving a book that still validates", () => {
    const { book, cashId } = bookWithAssets();
    const withExpense = unwrap(
      createAccount(
        book,
        { parentId: null, name: "Rent", type: "expense", currency: "ILS", isPlaceholder: false },
        NOW,
      ),
    );
    const rentId = withExpense.accounts[withExpense.accounts.length - 1].id;
    const withRule = unwrap(
      createRecurrence(
        withExpense,
        {
          description: "Rent",
          fromAccountId: cashId,
          lines: [{ toAccountId: rentId, amount: 300000 }],
          every: 1,
          unit: "month",
          startDate: "2026-01-01",
          endDate: null,
        },
        NOW,
      ),
    );
    const ruleId = withRule.recurrences[0].id;

    const next = unwrap(deleteAccount(withRule, cashId, NOW));

    expect(next.recurrences).toEqual([]);
    expect(next.tombstones.some((t) => t.kind === "recurrence" && t.key === ruleId)).toBe(true);
    // The point of the whole fix: a book that used to fail validation (BL-023's sharp
    // edge — a book that fails to validate falls through to onboarding) now loads clean.
    expect(unwrap(validateBook(next))).toBe(true);
  });
});
