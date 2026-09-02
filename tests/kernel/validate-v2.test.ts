import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { validateBook } from "../../src/kernel/validate";
import { NOW, unwrap, unwrapErr } from "../helpers";

function violations(result: ReturnType<typeof validateBook>) {
  const error = unwrapErr(result);
  return (error.details?.violations as Array<{ code: string }>).map((v) => v.code);
}

describe("validateBook v2", () => {
  it("accepts a fresh v2 book", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    expect(validateBook(book).ok).toBe(true);
  });

  it("rejects schemaVersion 1", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    const legacy = { ...book, schemaVersion: 1 as any };
    expect(violations(validateBook(legacy))).toContain("BOOK_INVALID_SCHEMA_VERSION");
  });

  it("rejects a record without updatedAt and a malformed tombstone", () => {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    book = unwrap(
      createAccount(book, { parentId: null, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false }, NOW),
    );
    const broken: any = structuredClone(book);
    delete broken.accounts[0].updatedAt;
    broken.tombstones = [{ kind: "nope", key: 1 }];
    const codes = violations(validateBook(broken));
    expect(codes).toContain("BOOK_INVALID");
  });

  it("rejects a live record with a tombstone for the same key", () => {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    book = unwrap(
      createAccount(book, { parentId: null, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false }, NOW),
    );
    const clone = structuredClone(book);
    clone.tombstones.push({
      kind: "account",
      key: clone.accounts[0].id,
      deletedAt: NOW,
      record: clone.accounts[0],
    });
    expect(violations(validateBook(clone))).toContain("BOOK_INVALID");
  });
});
