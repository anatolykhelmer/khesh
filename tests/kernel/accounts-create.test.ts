import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { unwrap, unwrapErr } from "../helpers";

function emptyBook() {
  return unwrap(createBook({ name: "Home", homeCurrency: "ILS" }));
}

describe("createAccount", () => {
  it("creates a root placeholder and a child leaf", () => {
    let book = emptyBook();
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: " Assets ",
        type: "asset",
        currency: "ILS",
        isPlaceholder: true,
      }),
    );
    const assets = book.accounts[0];
    expect(assets.name).toBe("Assets");
    expect(assets.parentId).toBeNull();
    expect(assets.isPlaceholder).toBe(true);
    expect(assets.id.length).toBeGreaterThan(0);

    book = unwrap(
      createAccount(book, {
        parentId: assets.id,
        name: "Cash",
        type: "asset",
        currency: "USD",
        isPlaceholder: false,
      }),
    );
    expect(book.accounts[1].currency).toBe("USD");
    expect(book.accounts[1].parentId).toBe(assets.id);
  });

  it("rejects empty name", () => {
    const book = emptyBook();
    expect(
      unwrapErr(
        createAccount(book, {
          parentId: null,
          name: " ",
          type: "asset",
          currency: "ILS",
          isPlaceholder: false,
        }),
      ).code,
    ).toBe("ACCOUNT_NAME_INVALID");
  });

  it("rejects duplicate sibling names", () => {
    let book = emptyBook();
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }),
    );
    expect(
      unwrapErr(
        createAccount(book, {
          parentId: null,
          name: "Cash",
          type: "asset",
          currency: "ILS",
          isPlaceholder: false,
        }),
      ).code,
    ).toBe("ACCOUNT_NAME_DUPLICATE");
  });

  it("rejects missing parent", () => {
    const book = emptyBook();
    expect(
      unwrapErr(
        createAccount(book, {
          parentId: "missing",
          name: "Cash",
          type: "asset",
          currency: "ILS",
          isPlaceholder: false,
        }),
      ).code,
    ).toBe("ACCOUNT_PARENT_INVALID");
  });

  it("rejects child under non-placeholder", () => {
    let book = emptyBook();
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }),
    );
    expect(
      unwrapErr(
        createAccount(book, {
          parentId: book.accounts[0].id,
          name: "Wallet",
          type: "asset",
          currency: "ILS",
          isPlaceholder: false,
        }),
      ).code,
    ).toBe("ACCOUNT_PARENT_NOT_PLACEHOLDER");
  });

  it("rejects child type mismatch", () => {
    let book = emptyBook();
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Assets",
        type: "asset",
        currency: "ILS",
        isPlaceholder: true,
      }),
    );
    expect(
      unwrapErr(
        createAccount(book, {
          parentId: book.accounts[0].id,
          name: "Salary",
          type: "income",
          currency: "ILS",
          isPlaceholder: false,
        }),
      ).code,
    ).toBe("ACCOUNT_TYPE_MISMATCH");
  });

  it("rejects invalid currency", () => {
    const book = emptyBook();
    expect(
      unwrapErr(
        createAccount(book, {
          parentId: null,
          name: "Cash",
          type: "asset",
          currency: "usd",
          isPlaceholder: false,
        }),
      ).code,
    ).toBe("INVALID_CURRENCY_CODE");
  });

  it("does not mutate the original book", () => {
    const book = emptyBook();
    unwrap(
      createAccount(book, {
        parentId: null,
        name: "Cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }),
    );
    expect(book.accounts).toEqual([]);
  });
});
