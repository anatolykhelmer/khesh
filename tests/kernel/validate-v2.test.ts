import { createAccount } from "../../src/kernel/accounts";
import { setBudget } from "../../src/kernel/budgets";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { validateBook } from "../../src/kernel/validate";
import { NOW, unwrap, unwrapErr } from "../helpers";

function violations(result: ReturnType<typeof validateBook>) {
  const error = unwrapErr(result);
  return error.details?.violations as Array<{
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }>;
}

function codes(result: ReturnType<typeof validateBook>) {
  return violations(result).map((v) => v.code);
}

function messages(result: ReturnType<typeof validateBook>) {
  return violations(result).map((v) => v.message);
}

function bookWithAccount() {
  const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
  return unwrap(
    createAccount(book, { parentId: null, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false }, NOW),
  );
}

/** One account, one entry and one budget — a record of each kind that carries updatedAt. */
function bookWithEveryRecordKind() {
  let book = bookWithAccount();
  book = unwrap(
    createAccount(book, { parentId: null, name: "Food", type: "expense", currency: "ILS", isPlaceholder: false }, NOW),
  );
  const [cash, food] = book.accounts;
  book = unwrap(
    postEntry(book, {
      date: "2026-01-10",
      description: "Groceries",
      postings: [
        { accountId: food.id, side: "debit", amount: 500 },
        { accountId: cash.id, side: "credit", amount: 500 },
      ],
    }, NOW),
  );
  return unwrap(
    setBudget(book, { accountId: food.id, period: "month", currency: "ILS", limit: 100 }, NOW),
  );
}

describe("validateBook v2", () => {
  it("accepts a fresh v2 book", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    expect(validateBook(book).ok).toBe(true);
  });

  it("rejects schemaVersion 1", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    const legacy = { ...book, schemaVersion: 1 as any };
    expect(codes(validateBook(legacy))).toContain("BOOK_INVALID_SCHEMA_VERSION");
  });

  it("rejects a book whose metaUpdatedAt is missing", () => {
    const broken: any = structuredClone(bookWithAccount());
    delete broken.metaUpdatedAt;
    expect(messages(validateBook(broken))).toContain("Book metaUpdatedAt must be a string");
  });

  it("rejects an account, an entry and a budget that lost updatedAt", () => {
    const broken: any = structuredClone(bookWithEveryRecordKind());
    delete broken.accounts[0].updatedAt;
    delete broken.journal[0].updatedAt;
    delete broken.budgets[0].updatedAt;
    const missing = violations(validateBook(broken)).filter(
      (v) => v.message === "Record missing updatedAt",
    );
    expect(missing).toHaveLength(3);
    expect(missing.every((v) => v.code === "BOOK_INVALID")).toBe(true);
  });

  it("rejects a malformed tombstone element", () => {
    const broken: any = structuredClone(bookWithAccount());
    broken.tombstones = [{ kind: "nope", key: 1 }];
    expect(messages(validateBook(broken))).toContain("Invalid tombstone element");
  });

  it("rejects a live record with a tombstone for the same key", () => {
    const clone = structuredClone(bookWithAccount());
    clone.tombstones.push({
      kind: "account",
      key: clone.accounts[0].id,
      deletedAt: NOW,
      record: clone.accounts[0],
    });
    const shadowing = violations(validateBook(clone)).filter(
      (v) => v.message === "Tombstone shadows a live record",
    );
    expect(shadowing).toHaveLength(1);
    expect(shadowing[0]).toMatchObject({
      code: "BOOK_INVALID",
      details: { kind: "account", key: clone.accounts[0].id },
    });
  });

  // The tombstone pass must not re-dereference elements the loops above rejected:
  // a null budget is reachable through jsonToBook, whose shape check never inspects
  // budget elements. validateBook's contract is to return a Result, never throw.
  it("reports null journal and budget elements instead of throwing", () => {
    const broken: any = structuredClone(bookWithEveryRecordKind());
    broken.journal.push(null);
    broken.budgets.push(null);
    expect(messages(validateBook(broken))).toEqual(
      expect.arrayContaining(["Invalid journal entry element", "Invalid budget element"]),
    );
  });
});
