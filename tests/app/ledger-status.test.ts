import { describe, expect, it } from "vitest";
import { createBook } from "../../src/kernel/create-book";
import { deriveStatus } from "../../src/app/ledger-status";
import { NOW, unwrap } from "../helpers";

const BOOK = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));

describe("deriveStatus", () => {
  it("is loading while the first boot is in flight, whatever else is set", () => {
    expect(deriveStatus(true, null, null)).toBe("loading");
    expect(deriveStatus(true, BOOK, null)).toBe("loading");
    expect(deriveStatus(true, null, "STORAGE_UNAVAILABLE")).toBe("loading");
  });

  it("is ready as soon as there is a book", () => {
    expect(deriveStatus(false, BOOK, null)).toBe("ready");
  });

  it("is ready even with a stale boot error, because a recovered book outranks it", () => {
    expect(deriveStatus(false, BOOK, "BOOK_INVALID")).toBe("ready");
  });

  it("is failed when there is no book and a reason why", () => {
    expect(deriveStatus(false, null, "BOOK_INVALID")).toBe("failed");
    expect(deriveStatus(false, null, "STORAGE_UNAVAILABLE")).toBe("failed");
  });

  it("is empty when there is no book and nothing went wrong", () => {
    expect(deriveStatus(false, null, null)).toBe("empty");
  });
});
