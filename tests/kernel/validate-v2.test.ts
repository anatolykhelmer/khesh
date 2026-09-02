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

  // validateBook's contract is to return a Result, never throw — Task 5's
  // decodeEnvelope runs it on unvalidated Drive JSON with no shape check in front,
  // so a corrupted remote file must produce violations, not an unhandled rejection.
  // Covers both the tombstone pass (which must not re-dereference elements the loops
  // rejected) and the book-utils scans validateBook reaches: siblingNameTaken and
  // wouldCreateCycle -> findAccount.
  it("reports null account, journal and budget elements instead of throwing", () => {
    const broken: any = structuredClone(bookWithEveryRecordKind());
    broken.accounts.push(null);
    broken.journal.push(null);
    broken.budgets.push(null);
    expect(messages(validateBook(broken))).toEqual(
      expect.arrayContaining([
        "Invalid account element",
        "Invalid journal entry element",
        "Invalid budget element",
      ]),
    );
  });

  // validatePostings dereferences every element, so validate.ts must not hand it an
  // array holding a malformed one. Reached the same way as the cases above.
  it("reports a null posting element instead of throwing", () => {
    const broken: any = structuredClone(bookWithEveryRecordKind());
    broken.journal[0].postings.push(null);
    const result = validateBook(broken);
    expect(messages(result)).toContain("Invalid posting element");
    // The entry's balance is unknowable once an element is malformed, so the check
    // is skipped rather than run on the survivors — no invented imbalance verdict.
    expect(messages(result)).not.toContain("Debits must equal credits");
  });

  it.each([
    ["accounts", "Book accounts must be an array"],
    ["journal", "Book journal must be an array"],
  ])("reports a non-array %s instead of throwing", (field, message) => {
    const broken: any = structuredClone(bookWithEveryRecordKind());
    broken[field] = null;
    expect(messages(validateBook(broken))).toContain(message);
  });

  // findAccount is reached from the accounts loop via wouldCreateCycle, which walks
  // parent links; a malformed element must not throw during that walk either.
  it("reports a null account element in a book whose accounts have parents", () => {
    const parent = unwrap(
      createAccount(
        unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW)),
        { parentId: null, name: "Expenses", type: "expense", currency: "ILS", isPlaceholder: true },
        NOW,
      ),
    );
    const withChild = unwrap(
      createAccount(
        parent,
        { parentId: parent.accounts[0].id, name: "Food", type: "expense", currency: "ILS", isPlaceholder: false },
        NOW,
      ),
    );
    const broken: any = structuredClone(withChild);
    broken.accounts.unshift(null);
    expect(messages(validateBook(broken))).toContain("Invalid account element");
  });
});
