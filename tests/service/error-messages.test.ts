import { describe, expect, it } from "vitest";
import { errorMessage } from "../../src/service/error-messages";

describe("errorMessage", () => {
  it("maps known codes to English copy", () => {
    expect(errorMessage("ACCOUNT_NAME_DUPLICATE")).toMatch(/already/i);
    expect(errorMessage("STORAGE_WRITE_FAILED")).toMatch(/save/i);
  });

  it("covers the account-tree codes rather than falling back", () => {
    for (const code of [
      "ACCOUNT_HAS_CHILDREN",
      "ACCOUNT_HAS_POSTINGS",
      "ACCOUNT_CYCLE",
      "ACCOUNT_IS_SYSTEM",
      "ACCOUNT_TYPE_MISMATCH",
    ]) {
      expect(errorMessage(code)).not.toBe("Something went wrong");
    }
  });

  it("covers the import codes rather than falling back", () => {
    for (const code of [
      "JSON_PARSE_FAILED",
      "JSON_INVALID_BOOK",
      "BOOK_INVALID_SCHEMA_VERSION",
      "FILE_READ_FAILED",
    ]) {
      expect(errorMessage(code)).not.toBe("Something went wrong");
    }
  });

  it("falls back for unknown codes", () => {
    expect(errorMessage("NOT_A_REAL_CODE")).toBe("Something went wrong");
  });
});
