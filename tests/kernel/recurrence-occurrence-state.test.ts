import { describe, expect, it } from "vitest";
import { createBook } from "../../src/kernel/create-book";
import { dueOccurrences } from "../../src/kernel/occurrences";
import {
  createRecurrence,
  deferOccurrence,
  setRecurrencePaused,
  skipOccurrence,
} from "../../src/kernel/recurrences";
import { validateBook } from "../../src/kernel/validate";
import type { Book } from "../../src/kernel/types";
import { unwrap, unwrapErr, NOW, LATER } from "../helpers";

const TODAY = "2026-06-15";

function withRule(): Book {
  const book = unwrap(createBook({ name: "Household", homeCurrency: "ILS" }, NOW));
  book.accounts = [
    { id: "bank", parentId: null, name: "Bank", type: "asset", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
    { id: "rent", parentId: null, name: "Rent", type: "expense", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
  ];
  return unwrap(
    createRecurrence(
      book,
      {
        id: "r1",
        description: "Rent",
        fromAccountId: "bank",
        lines: [{ toAccountId: "rent", amount: 300000 }],
        every: 1,
        unit: "month",
        startDate: "2026-04-01",
        endDate: null,
      },
      NOW,
    ),
  );
}

describe("skipOccurrence", () => {
  it("removes that date from the queue for good", () => {
    const book = unwrap(skipOccurrence(withRule(), "r1", "2026-05-01", TODAY, LATER));
    expect(dueOccurrences(book, TODAY).map((o) => o.date)).toEqual(["2026-04-01", "2026-06-01"]);
    expect(book.recurrences[0].updatedAt).toBe(LATER);
  });

  it("is idempotent", () => {
    const once = unwrap(skipOccurrence(withRule(), "r1", "2026-05-01", TODAY, LATER));
    const twice = unwrap(skipOccurrence(once, "r1", "2026-05-01", TODAY, LATER));
    expect(twice.recurrences[0].skipped).toEqual(["2026-05-01"]);
  });

  it("refuses an unknown rule", () => {
    expect(unwrapErr(skipOccurrence(withRule(), "nope", "2026-05-01", TODAY, LATER)).code).toBe(
      "RECURRENCE_NOT_FOUND",
    );
  });

  it("drops dates that fell out of the window, so the list cannot grow forever", () => {
    const book = withRule();
    book.recurrences[0].skipped = ["2000-01-01", "2026-04-01"];
    const next = unwrap(skipOccurrence(book, "r1", "2026-05-01", TODAY, LATER));
    expect(next.recurrences[0].skipped).toEqual(["2026-04-01", "2026-05-01"]);
  });
});

describe("deferOccurrence", () => {
  it("keeps the occurrence due but marks it deferred", () => {
    const book = unwrap(deferOccurrence(withRule(), "r1", "2026-05-01", TODAY, LATER));
    const due = dueOccurrences(book, TODAY);
    expect(due.map((o) => o.date)).toEqual(["2026-04-01", "2026-05-01", "2026-06-01"]);
    expect(due.find((o) => o.date === "2026-05-01")?.deferred).toBe(true);
  });
});

describe("setRecurrencePaused", () => {
  it("pausing silences the rule entirely", () => {
    const book = unwrap(setRecurrencePaused(withRule(), "r1", true, "2026-05-10", LATER));
    expect(book.recurrences[0].pausedAt).toBe("2026-05-10");
    expect(dueOccurrences(book, TODAY)).toEqual([]);
  });

  it("resuming closes the paused span instead of replaying it", () => {
    const paused = unwrap(setRecurrencePaused(withRule(), "r1", true, "2026-04-20", LATER));
    const resumed = unwrap(setRecurrencePaused(paused, "r1", false, "2026-08-15", LATER));
    expect(resumed.recurrences[0].pausedAt).toBeNull();
    // Paused 20 April, resumed 15 August, so every occurrence inside that span — 1 May
    // through 1 August — is closed. The 1 April occurrence was already pending before
    // the pause began and survives it: pausing is not a way to clear a backlog.
    expect(dueOccurrences(resumed, "2026-08-15").map((o) => o.date)).toEqual(["2026-04-01"]);
  });

  it("keeps an occurrence that was already pending before the pause", () => {
    const paused = unwrap(setRecurrencePaused(withRule(), "r1", true, "2026-05-10", LATER));
    const resumed = unwrap(setRecurrencePaused(paused, "r1", false, "2026-06-15", LATER));
    // 1 April and 1 May were pending before 10 May; only 1 June falls inside the pause.
    expect(dueOccurrences(resumed, TODAY).map((o) => o.date)).toEqual(["2026-04-01", "2026-05-01"]);
  });

  it("leaves a valid book", () => {
    const paused = unwrap(setRecurrencePaused(withRule(), "r1", true, "2026-04-20", LATER));
    const resumed = unwrap(setRecurrencePaused(paused, "r1", false, "2026-08-15", LATER));
    expect(unwrap(validateBook(resumed))).toBe(true);
  });
});
