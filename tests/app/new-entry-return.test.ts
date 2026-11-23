import { describe, expect, it } from "vitest";
import {
  addedEntryId,
  afterCreatePath,
  newEntryLinkState,
  readCreatedEntryId,
  readReturnTo,
} from "../../src/app/new-entry-return";

describe("newEntryLinkState", () => {
  it("carries the journal list's address, query included", () => {
    expect(newEntryLinkState({ pathname: "/journal", search: "?month=2026-03&account=abc" })).toEqual({
      returnTo: "/journal?month=2026-03&account=abc",
    });
    expect(newEntryLinkState({ pathname: "/journal", search: "" })).toEqual({ returnTo: "/journal" });
  });

  it("carries nothing from anywhere else, an entry's own page included", () => {
    for (const pathname of ["/dashboard", "/journal/01ABC", "/journal/01ABC/edit", "/new", "/accounts"]) {
      expect(newEntryLinkState({ pathname, search: "?month=2026-03" }), pathname).toBeUndefined();
    }
  });
});

describe("readReturnTo", () => {
  it("reads back what newEntryLinkState wrote", () => {
    const state = newEntryLinkState({ pathname: "/journal", search: "?account=abc" });
    expect(readReturnTo(state)).toBe("/journal?account=abc");
  });

  it("ignores anything that is not a journal-list address", () => {
    // History state survives reloads and can be anything; never navigate somewhere it names
    // unless it is the journal list.
    for (const state of [
      null,
      undefined,
      "x",
      42,
      {},
      { returnTo: 7 },
      { returnTo: "/settings" },
      { returnTo: "/journal/01ABC" },
      { returnTo: "/journalx" },
      { returnTo: "https://example.com/journal" },
      { returnTo: "//example.com/journal" },
    ]) {
      expect(readReturnTo(state), JSON.stringify(state)).toBeNull();
    }
  });
});

describe("afterCreatePath", () => {
  it("goes back to the journal view the entry was started from", () => {
    expect(afterCreatePath("/journal?month=2026-03&account=abc", "2026-11-20")).toBe(
      "/journal?month=2026-03&account=abc",
    );
  });

  it("otherwise opens the entry's own month with no account, so the entry is on screen", () => {
    expect(afterCreatePath(null, "2026-09-04")).toBe("/journal?month=2026-09");
  });
});

describe("addedEntryId", () => {
  it("finds the entry the write added", () => {
    const before = { journal: [{ id: "a" }, { id: "b" }] };
    const after = { journal: [{ id: "a" }, { id: "c" }, { id: "b" }] };
    expect(addedEntryId(before, after)).toBe("c");
  });

  it("is null when nothing was added", () => {
    const book = { journal: [{ id: "a" }] };
    expect(addedEntryId(book, { journal: [{ id: "a" }] })).toBeNull();
    expect(addedEntryId(book, { journal: [] })).toBeNull();
  });
});

describe("readCreatedEntryId", () => {
  it("reads the id the form passed along", () => {
    expect(readCreatedEntryId({ createdEntryId: "c" })).toBe("c");
  });

  it("is null for any other state", () => {
    for (const state of [null, undefined, "c", {}, { createdEntryId: 1 }, { returnTo: "/journal" }]) {
      expect(readCreatedEntryId(state), JSON.stringify(state)).toBeNull();
    }
  });
});
