import { describe, expect, it } from "vitest";
import { createBook } from "../../src/kernel/create-book";
import { shouldTearDown } from "../../src/app/sync/teardown-rule";
import { NOW, unwrap } from "../helpers";

const BOOK = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));

describe("shouldTearDown", () => {
  it("tears down when a book that existed is gone and something is connected", () => {
    expect(shouldTearDown(BOOK, null, true)).toBe(true);
  });

  it("leaves a connection begun while there was already no book", () => {
    // The no-book screens can start a connect. Its pendingInspection re-runs the effect
    // with the book null on both sides; tearing down here would destroy the choice the
    // user just opened.
    expect(shouldTearDown(null, null, true)).toBe(false);
  });

  it("does nothing on the first render, when there is no previous book", () => {
    expect(shouldTearDown(undefined, null, true)).toBe(false);
  });

  it("does nothing when a book arrives", () => {
    expect(shouldTearDown(null, BOOK, true)).toBe(false);
    expect(shouldTearDown(BOOK, BOOK, true)).toBe(false);
  });

  it("does nothing when there is no connection to tear down", () => {
    expect(shouldTearDown(BOOK, null, false)).toBe(false);
  });
});
