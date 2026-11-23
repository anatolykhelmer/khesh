import { createAccount, deleteAccount } from "../../src/kernel/accounts";
import { NOW, unwrap, unwrapErr } from "../helpers";
import { accountNamed, realBook, rootAccounts, ROOT } from "../helpers/book";
import { validateBook } from "../../src/kernel/validate";

describe("createAccount", () => {
  it("creates a placeholder group and a child leaf", () => {
    let book = realBook();
    book = unwrap(
      createAccount(book, {
        parentId: ROOT.asset,
        name: " Bank ",
        type: "asset",
        currency: "ILS",
        isPlaceholder: true,
      }, NOW),
    );
    const bank = accountNamed(book, "Bank");
    expect(bank.name).toBe("Bank");
    expect(bank.parentId).toBe(ROOT.asset);
    expect(bank.isPlaceholder).toBe(true);
    expect(bank.id.length).toBeGreaterThan(0);

    book = unwrap(
      createAccount(book, {
        parentId: bank.id,
        name: "Cash",
        type: "asset",
        currency: "USD",
        isPlaceholder: false,
      }, NOW),
    );
    const cash = accountNamed(book, "Cash");
    expect(cash.currency).toBe("USD");
    expect(cash.parentId).toBe(bank.id);
  });

  it("rejects empty name", () => {
    const book = realBook();
    expect(
      unwrapErr(
        createAccount(book, {
          parentId: ROOT.asset,
          name: " ",
          type: "asset",
          currency: "ILS",
          isPlaceholder: false,
        }, NOW),
      ).code,
    ).toBe("ACCOUNT_NAME_INVALID");
  });

  it("rejects duplicate sibling names", () => {
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
    expect(
      unwrapErr(
        createAccount(book, {
          parentId: ROOT.asset,
          name: "Cash",
          type: "asset",
          currency: "ILS",
          isPlaceholder: false,
        }, NOW),
      ).code,
    ).toBe("ACCOUNT_NAME_DUPLICATE");
  });

  it("rejects missing parent", () => {
    const book = realBook();
    expect(
      unwrapErr(
        createAccount(book, {
          parentId: "missing",
          name: "Cash",
          type: "asset",
          currency: "ILS",
          isPlaceholder: false,
        }, NOW),
      ).code,
    ).toBe("ACCOUNT_PARENT_INVALID");
  });

  it("rejects child under non-placeholder", () => {
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
    const cash = accountNamed(book, "Cash");
    expect(
      unwrapErr(
        createAccount(book, {
          parentId: cash.id,
          name: "Wallet",
          type: "asset",
          currency: "ILS",
          isPlaceholder: false,
        }, NOW),
      ).code,
    ).toBe("ACCOUNT_PARENT_NOT_PLACEHOLDER");
  });

  it("rejects child type mismatch", () => {
    const book = realBook();
    expect(
      unwrapErr(
        createAccount(book, {
          parentId: ROOT.asset,
          name: "Salary",
          type: "income",
          currency: "ILS",
          isPlaceholder: false,
        }, NOW),
      ).code,
    ).toBe("ACCOUNT_TYPE_MISMATCH");
  });

  it("rejects invalid currency", () => {
    const book = realBook();
    expect(
      unwrapErr(
        createAccount(book, {
          parentId: ROOT.asset,
          name: "Cash",
          type: "asset",
          currency: "usd",
          isPlaceholder: false,
        }, NOW),
      ).code,
    ).toBe("INVALID_CURRENCY_CODE");
  });

  it("does not mutate the original book", () => {
    const book = realBook();
    unwrap(
      createAccount(book, {
        parentId: ROOT.asset,
        name: "Cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    expect(book.accounts).toEqual(rootAccounts());
  });

  it("takes an explicit id, so a starter plan can mint its own", () => {
    const next = unwrap(
      createAccount(
        realBook(),
        { id: "seed:cash:ILS", parentId: ROOT.asset, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false },
        NOW,
      ),
    );
    expect(accountNamed(next, "Cash").id).toBe("seed:cash:ILS");
  });

  it("refuses an explicit id that is already taken, which validateBook would reject too", () => {
    const book = unwrap(
      createAccount(realBook(), { id: "seed:cash:ILS", parentId: ROOT.asset, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false }, NOW),
    );
    expect(
      unwrapErr(
        createAccount(book, { id: "seed:cash:ILS", parentId: ROOT.asset, name: "Wallet", type: "asset", currency: "ILS", isPlaceholder: false }, NOW),
      ).code,
    ).toBe("ACCOUNT_ID_DUPLICATE");
  });

  it("clears a tombstone the explicit id would otherwise be shadowed by", () => {
    let book = unwrap(
      createAccount(realBook(), { id: "seed:cash:ILS", parentId: ROOT.asset, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false }, NOW),
    );
    book = unwrap(deleteAccount(book, "seed:cash:ILS", NOW));
    expect(book.tombstones).toHaveLength(1);
    const again = unwrap(
      createAccount(book, { id: "seed:cash:ILS", parentId: ROOT.asset, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false }, NOW),
    );
    expect(again.tombstones).toHaveLength(0);
    expect(validateBook(again).ok).toBe(true);
  });
});
