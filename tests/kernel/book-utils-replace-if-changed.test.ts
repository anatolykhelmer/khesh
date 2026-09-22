import { describe, expect, it } from "vitest";
import { replaceIfChanged } from "../../src/kernel/book-utils";
import type { Book } from "../../src/kernel/types";
import { NOW, LATER } from "../helpers";
import { accountNamed, realBook, ROOT } from "../helpers/book";

function seeded(): Book {
  const book = realBook();
  book.accounts.push(
    { id: "bank", parentId: ROOT.asset, name: "Bank", type: "asset", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
  );
  return book;
}

describe("replaceIfChanged", () => {
  it("returns the same book when the candidate equals the record ignoring updatedAt", () => {
    const book = seeded();
    const bank = accountNamed(book, "Bank");
    const candidate = { ...bank, updatedAt: LATER };
    const result = replaceIfChanged(book, "accounts", book.accounts.length - 1, candidate, LATER);
    expect(result).toBe(book);
    expect(accountNamed(book, "Bank").updatedAt).toBe(NOW);
  });

  it("returns a clone with the candidate stamped when a field differs", () => {
    const book = seeded();
    const bank = accountNamed(book, "Bank");
    const result = replaceIfChanged(
      book,
      "accounts",
      book.accounts.length - 1,
      { ...bank, name: "Wallet" },
      LATER,
    );
    expect(result).not.toBe(book);
    expect(accountNamed(result, "Wallet")).toEqual({ ...bank, name: "Wallet", updatedAt: LATER });
    expect(accountNamed(book, "Bank").name).toBe("Bank");
  });

  it("compares structurally, not by reference, and ignores key order", () => {
    const book = seeded();
    const { id, parentId, name, type, currency, isPlaceholder } = accountNamed(book, "Bank");
    const reordered = { updatedAt: LATER, isPlaceholder, currency, type, name, parentId, id };
    expect(replaceIfChanged(book, "accounts", book.accounts.length - 1, reordered, LATER)).toBe(book);
  });

  it("does not alias the candidate's nested arrays into the new book", () => {
    const book = seeded();
    book.recurrences = [
      {
        id: "r1",
        description: "Rent",
        fromAccountId: "bank",
        lines: [{ toAccountId: "bank", amount: 1 }],
        every: 1,
        unit: "month",
        startDate: "2026-01-01",
        endDate: null,
        pausedAt: null,
        skipped: [],
        deferred: [],
        updatedAt: NOW,
      },
    ];
    const candidate = { ...book.recurrences[0], pausedAt: "2026-06-01" };
    const result = replaceIfChanged(book, "recurrences", 0, candidate, LATER);
    expect(result.recurrences[0].skipped).not.toBe(candidate.skipped);
    expect(result.recurrences[0].pausedAt).toBe("2026-06-01");
    expect(result.recurrences[0].updatedAt).toBe(LATER);
  });
});
