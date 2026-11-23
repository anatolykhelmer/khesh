import { describe, expect, it } from "vitest";
import { createAccount } from "../../src/kernel/accounts";
import {
  hasExplicitJournalView,
  isDefaultFilter,
  parseJournalFilter,
  toJournalParams,
  toListJournalFilter,
} from "../../src/app/journal-filter";
import { NOW as ISO_NOW, unwrap } from "../helpers";
import { accountNamed, realBook, ROOT } from "../helpers/book";

const NOW = new Date(2026, 7, 12); // 12 August 2026

function bookWithAccount() {
  let book = realBook();
  book = unwrap(
    createAccount(book, {
      parentId: ROOT.asset,
      name: "Cash",
      type: "asset",
      currency: "ILS",
      isPlaceholder: false,
    }, ISO_NOW),
  );
  return { book, cashId: accountNamed(book, "Cash").id };
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

describe("hasExplicitJournalView", () => {
  it("is false for a bare query string and for unrelated parameters", () => {
    expect(hasExplicitJournalView(new URLSearchParams())).toBe(false);
    expect(hasExplicitJournalView(new URLSearchParams("utm_source=x"))).toBe(false);
  });

  it("is true when the month or the account is given, whatever its value", () => {
    for (const raw of ["month=2026-03", "month=all", "month=", "account=abc", "month=all&account=abc"]) {
      expect(hasExplicitJournalView(new URLSearchParams(raw)), raw).toBe(true);
    }
  });
});

describe("toJournalParams", () => {
  it("writes a past month and an account", () => {
    expect(
      toJournalParams({ period: { year: 2026, month: 3 }, accountId: "abc" }, NOW).toString(),
    ).toBe("month=2026-03&account=abc");
  });

  it("writes all time as month=all", () => {
    expect(toJournalParams({ period: null, accountId: null }, NOW).toString()).toBe("month=all");
  });

  it("leaves the current month out, so the default view is a bare query string", () => {
    expect(toJournalParams({ period: { year: 2026, month: 8 }, accountId: null }, NOW).toString()).toBe("");
    expect(toJournalParams({ period: { year: 2026, month: 8 }, accountId: "abc" }, NOW).toString()).toBe(
      "account=abc",
    );
  });

  it("describes what parseJournalFilter made of a broken query, not the query itself", () => {
    const { book } = bookWithAccount();
    const parsed = parseJournalFilter(new URLSearchParams("month=garbage&account=gone"), book, NOW);
    expect(toJournalParams(parsed, NOW).toString()).toBe("");
  });
});
