import { createAccount, deleteAccount, updateAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { unwrap, unwrapErr } from "../helpers";
import type { Book } from "../../src/kernel/types";

function bookWithAssets(): { book: Book; assetsId: string; cashId: string } {
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
  const assetsId = book.accounts[0].id;
  book = unwrap(
    createAccount(book, {
      parentId: assetsId,
      name: "Cash",
      type: "asset",
      currency: "ILS",
      isPlaceholder: false,
    }),
  );
  const cashId = book.accounts[1].id;
  return { book, assetsId, cashId };
}

describe("updateAccount", () => {
  it("renames an account", () => {
    const { book, cashId } = bookWithAssets();
    const next = unwrap(updateAccount(book, { id: cashId, name: " Wallet " }));
    expect(next.accounts.find((a) => a.id === cashId)?.name).toBe("Wallet");
  });

  it("rejects unknown id", () => {
    const { book } = bookWithAssets();
    expect(unwrapErr(updateAccount(book, { id: "nope", name: "X" })).code).toBe(
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
      }),
    );
    expect(
      unwrapErr(updateAccount(withBank, { id: cashId, name: "Bank" })).code,
    ).toBe("ACCOUNT_NAME_DUPLICATE");
  });

  it("rejects cycle", () => {
    const { book, assetsId } = bookWithAssets();
    expect(
      unwrapErr(updateAccount(book, { id: assetsId, parentId: book.accounts[1].id })).code,
    ).toBe("ACCOUNT_CYCLE");
  });

  it("rejects type change when account has children", () => {
    const { book, assetsId } = bookWithAssets();
    expect(unwrapErr(updateAccount(book, { id: assetsId, type: "liability" })).code).toBe(
      "ACCOUNT_HAS_CHILDREN",
    );
  });

  it("allows type/currency change on a posting-free leaf", () => {
    const { book, cashId } = bookWithAssets();
    const next = unwrap(updateAccount(book, { id: cashId, type: "asset", currency: "USD" }));
    expect(next.accounts.find((a) => a.id === cashId)?.currency).toBe("USD");
  });

  it("rejects turning placeholder off when it has children", () => {
    const { book, assetsId } = bookWithAssets();
    expect(
      unwrapErr(updateAccount(book, { id: assetsId, isPlaceholder: false })).code,
    ).toBe("ACCOUNT_HAS_CHILDREN");
  });
});

describe("deleteAccount", () => {
  it("deletes a leaf with no postings", () => {
    const { book, cashId } = bookWithAssets();
    const next = unwrap(deleteAccount(book, cashId));
    expect(next.accounts.find((a) => a.id === cashId)).toBeUndefined();
  });

  it("rejects deleting a parent with children", () => {
    const { book, assetsId } = bookWithAssets();
    expect(unwrapErr(deleteAccount(book, assetsId)).code).toBe("ACCOUNT_HAS_CHILDREN");
  });

  it("rejects unknown id", () => {
    const { book } = bookWithAssets();
    expect(unwrapErr(deleteAccount(book, "nope")).code).toBe("ACCOUNT_NOT_FOUND");
  });
});
