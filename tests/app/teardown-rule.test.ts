import { describe, expect, it } from "vitest";
import { createBook } from "../../src/kernel/create-book";
import { shouldTearDown, type TearDownSyncState } from "../../src/app/sync/teardown-rule";
import { NOW, unwrap } from "../helpers";

const BOOK = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));

const IDLE: TearDownSyncState = { connected: false, pendingInspection: null };
const CONNECTED: TearDownSyncState = { connected: true, pendingInspection: null };
const CHOOSING: TearDownSyncState = { connected: false, pendingInspection: { kind: "book" } };

describe("shouldTearDown", () => {
  it("tears down when a book that existed is gone and sync is connected", () => {
    expect(shouldTearDown(BOOK, null, CONNECTED)).toBe(true);
  });

  it("tears down on a pending first-connect choice even though connected is false", () => {
    // `connect()` binds storeRef/authRef/fileIdRef to the real Drive file when it
    // inspects it, so the choice screen is armed at that file with `connected` still
    // false. Narrowing the check to `connected` alone is what re-opens BL-040's
    // "Replace remote uploads a fresh seed over the real book" hole.
    expect(shouldTearDown(BOOK, null, CHOOSING)).toBe(true);
  });

  it("leaves a connection begun while there was already no book", () => {
    // The no-book screens can start a connect. Its pendingInspection re-runs the effect
    // with the book null on both sides; tearing down here would destroy the choice the
    // user just opened.
    expect(shouldTearDown(null, null, CONNECTED)).toBe(false);
    expect(shouldTearDown(null, null, CHOOSING)).toBe(false);
  });

  it("does nothing on the first run of the effect, when there is no previous book", () => {
    expect(shouldTearDown(undefined, null, CONNECTED)).toBe(false);
  });

  it("does nothing when a book arrives", () => {
    expect(shouldTearDown(null, BOOK, CONNECTED)).toBe(false);
    expect(shouldTearDown(BOOK, BOOK, CONNECTED)).toBe(false);
  });

  it("does nothing when sync is idle: no connection and no pending choice", () => {
    expect(shouldTearDown(BOOK, null, IDLE)).toBe(false);
  });
});
