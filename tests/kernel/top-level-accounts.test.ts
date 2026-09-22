import { describe, expect, it } from "vitest";
import { createAccount, updateAccount } from "../../src/kernel/accounts";
import { validateBook } from "../../src/kernel/validate";
import type { Book } from "../../src/kernel/types";
import { NOW, unwrap, unwrapErr } from "../helpers";
import { accountNamed, realBook, ROOT } from "../helpers/book";

function violationCodes(book: Book): string[] {
  const verdict = validateBook(book);
  return verdict.ok ? [] : (verdict.error.details?.violations as { code: string }[]).map((v) => v.code);
}

describe("validateBook: a top-level account is a category root", () => {
  it("accepts the four roots", () => {
    expect(violationCodes(realBook())).toEqual([]);
  });

  it("reports a top-level account that can hold money", () => {
    const book = realBook();
    book.accounts.push({
      id: "wallet", parentId: null, name: "Wallet", type: "asset", currency: "ILS", isPlaceholder: false, updatedAt: NOW,
    });
    expect(violationCodes(book)).toEqual(["ACCOUNT_ROOT_NOT_PLACEHOLDER"]);
  });

  it("says nothing about how many roots a type has", () => {
    // Two expense roots is what merging two separately onboarded devices produces today.
    // That is BL-048's to repair, and a book has to load before a merge can repair it.
    const book = realBook();
    book.accounts.push({
      id: "second", parentId: null, name: "Other", type: "expense", currency: "ILS", isPlaceholder: true, updatedAt: NOW,
    });
    expect(violationCodes(book)).toEqual([]);
  });
});

describe("createAccount at the top level", () => {
  it("refuses an account that can hold money", () => {
    const result = createAccount(
      realBook(),
      { parentId: null, name: "Wallet", type: "asset", currency: "ILS", isPlaceholder: false },
      NOW,
    );
    expect(unwrapErr(result).code).toBe("ACCOUNT_ROOT_NOT_PLACEHOLDER");
  });

  it("still creates a group, which is how createHousehold seeds the roots", () => {
    const book = unwrap(
      createAccount(realBook(), { parentId: null, name: "Reserves", type: "asset", currency: "ILS", isPlaceholder: true }, NOW),
    );
    expect(validateBook(book).ok).toBe(true);
    expect(accountNamed(book, "Reserves").parentId).toBeNull();
  });
});

describe("updateAccount at the top level", () => {
  it("refuses to turn a childless root into an account that holds money", () => {
    expect(unwrapErr(updateAccount(realBook(), { id: ROOT.liability, isPlaceholder: false }, NOW)).code).toBe(
      "ACCOUNT_ROOT_NOT_PLACEHOLDER",
    );
  });

  it("refuses to move a leaf to the top level", () => {
    const book = unwrap(
      createAccount(realBook(), { parentId: ROOT.asset, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false }, NOW),
    );
    expect(unwrapErr(updateAccount(book, { id: accountNamed(book, "Cash").id, parentId: null }, NOW)).code).toBe(
      "ACCOUNT_PARENT_INVALID",
    );
  });

  it("refuses to move a group to the top level, which would let a merge produce a top-level leaf", () => {
    // Device A moves Housing to the top; device B turns Housing into a leaf and posts to it.
    // If A's copy is newer, rung 3 ("postings force it off") makes a top-level leaf.
    const book = unwrap(
      createAccount(realBook(), { parentId: ROOT.expense, name: "Housing", type: "expense", currency: "ILS", isPlaceholder: true }, NOW),
    );
    expect(unwrapErr(updateAccount(book, { id: accountNamed(book, "Housing").id, parentId: null }, NOW)).code).toBe(
      "ACCOUNT_PARENT_INVALID",
    );
  });

  it("still renames a root, and retypes a childless one", () => {
    let book = unwrap(updateAccount(realBook(), { id: ROOT.expense, name: "Spending" }, NOW));
    book = unwrap(updateAccount(book, { id: ROOT.liability, type: "equity" }, NOW));
    expect(validateBook(book).ok).toBe(true);
  });
});
