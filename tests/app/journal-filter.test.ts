import { describe, expect, it } from "vitest";
import { createBook } from "../../src/kernel/create-book";
import { createAccount } from "../../src/kernel/accounts";
import {
  isDefaultFilter,
  parseJournalFilter,
  toListJournalFilter,
} from "../../src/app/journal-filter";
import { NOW as ISO_NOW, unwrap } from "../helpers";

const NOW = new Date(2026, 7, 12); // 12 August 2026

function bookWithAccount() {
  let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, ISO_NOW));
  book = unwrap(
    createAccount(book, {
      parentId: null,
      name: "Cash",
      type: "asset",
      currency: "ILS",
      isPlaceholder: false,
    }, ISO_NOW),
  );
  return { book, cashId: book.accounts[0].id };
}

describe("parseJournalFilter", () => {
  it("defaults to the current month and no account", () => {
    const { book } = bookWithAccount();
    expect(parseJournalFilter(new URLSearchParams(), book, NOW)).toEqual({
      period: { year: 2026, month: 8 },
      accountId: null,
    });
  });

  it("reads an explicit month", () => {
    const { book } = bookWithAccount();
    expect(parseJournalFilter(new URLSearchParams("month=2026-03"), book, NOW).period).toEqual({
      year: 2026,
      month: 3,
    });
  });

  it("treats month=all as no period", () => {
    const { book } = bookWithAccount();
    expect(parseJournalFilter(new URLSearchParams("month=all"), book, NOW).period).toBeNull();
  });

  it("falls back to the current month when the month is malformed", () => {
    const { book } = bookWithAccount();
    for (const raw of ["month=nonsense", "month=2026-13", "month=2026", "month="]) {
      expect(parseJournalFilter(new URLSearchParams(raw), book, NOW).period).toEqual({
        year: 2026,
        month: 8,
      });
    }
  });

  it("keeps an account id that exists in the book", () => {
    const { book, cashId } = bookWithAccount();
    expect(
      parseJournalFilter(new URLSearchParams(`account=${cashId}`), book, NOW).accountId,
    ).toBe(cashId);
  });

  it("drops an account id the book does not have", () => {
    const { book } = bookWithAccount();
    // A stale bookmark must not blank the screen with ACCOUNT_NOT_FOUND.
    expect(
      parseJournalFilter(new URLSearchParams("account=gone"), book, NOW).accountId,
    ).toBeNull();
  });
});

describe("toListJournalFilter", () => {
  it("turns a period into the month's bounds", () => {
    expect(toListJournalFilter({ period: { year: 2026, month: 2 }, accountId: null })).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
  });

  it("omits the date bounds for all-time", () => {
    expect(toListJournalFilter({ period: null, accountId: null })).toEqual({});
  });

  it("passes the account through", () => {
    expect(toListJournalFilter({ period: null, accountId: "abc" })).toEqual({ accountId: "abc" });
  });
});

describe("isDefaultFilter", () => {
  it("is true for the current month with no account", () => {
    expect(isDefaultFilter({ period: { year: 2026, month: 8 }, accountId: null }, NOW)).toBe(true);
  });

  it("is false for another month, for all-time, and when an account is chosen", () => {
    expect(isDefaultFilter({ period: { year: 2026, month: 7 }, accountId: null }, NOW)).toBe(false);
    expect(isDefaultFilter({ period: null, accountId: null }, NOW)).toBe(false);
    expect(isDefaultFilter({ period: { year: 2026, month: 8 }, accountId: "abc" }, NOW)).toBe(
      false,
    );
  });
});
