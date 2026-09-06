import { createBook } from "../../src/kernel/create-book";
import { NOW, unwrap, unwrapErr } from "../helpers";

describe("createBook", () => {
  it("creates an empty book with schemaVersion 2", () => {
    const book = unwrap(createBook({ name: " Family ", homeCurrency: "ILS" }, NOW));
    expect(book.schemaVersion).toBe(2);
    expect(book.name).toBe("Family");
    expect(book.homeCurrency).toBe("ILS");
    expect(book.accounts).toEqual([]);
    expect(book.journal).toEqual([]);
  });

  it("rejects empty name", () => {
    expect(unwrapErr(createBook({ name: "  ", homeCurrency: "ILS" }, NOW)).code).toBe(
      "BOOK_NAME_INVALID",
    );
  });

  it("rejects invalid currency", () => {
    expect(unwrapErr(createBook({ name: "Home", homeCurrency: "ils" }, NOW)).code).toBe(
      "INVALID_CURRENCY_CODE",
    );
    expect(unwrapErr(createBook({ name: "Home", homeCurrency: "US" }, NOW)).code).toBe(
      "INVALID_CURRENCY_CODE",
    );
  });

  it("seeds an empty budget list", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    expect(book.budgets).toEqual([]);
  });
});
