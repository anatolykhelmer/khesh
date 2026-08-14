import { createBook } from "../../src/kernel/create-book";
import { unwrap, unwrapErr } from "../helpers";

describe("createBook", () => {
  it("creates an empty book with schemaVersion 1", () => {
    const book = unwrap(createBook({ name: " Family ", homeCurrency: "ILS" }));
    expect(book.schemaVersion).toBe(1);
    expect(book.name).toBe("Family");
    expect(book.homeCurrency).toBe("ILS");
    expect(book.accounts).toEqual([]);
    expect(book.journal).toEqual([]);
  });

  it("rejects empty name", () => {
    expect(unwrapErr(createBook({ name: "  ", homeCurrency: "ILS" })).code).toBe(
      "BOOK_NAME_INVALID",
    );
  });

  it("rejects invalid currency", () => {
    expect(unwrapErr(createBook({ name: "Home", homeCurrency: "ils" })).code).toBe(
      "INVALID_CURRENCY_CODE",
    );
    expect(unwrapErr(createBook({ name: "Home", homeCurrency: "US" })).code).toBe(
      "INVALID_CURRENCY_CODE",
    );
  });
});
