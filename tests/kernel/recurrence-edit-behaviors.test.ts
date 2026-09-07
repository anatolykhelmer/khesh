import { describe, expect, it } from "vitest";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { dueOccurrences, recurrenceEntryId } from "../../src/kernel/occurrences";
import { createRecurrence, updateRecurrence } from "../../src/kernel/recurrences";
import type { Book } from "../../src/kernel/types";
import { unwrap, NOW, LATER } from "../helpers";

/**
 * Pins the two edit consequences the design spec (`docs/superpowers/specs/
 * 2026-09-06-recurring-transactions-design.md`, "Editing a rule") commits to in words:
 * occurrences are derived, never stored, so an edit is retroactive by construction. Both
 * are deliberate, not bugs — the point of these tests is that they cannot drift silently.
 */

function seeded(): Book {
  const book = unwrap(createBook({ name: "Household", homeCurrency: "ILS" }, NOW));
  book.accounts = [
    { id: "bank", parentId: null, name: "Bank", type: "asset", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
    { id: "rent", parentId: null, name: "Rent", type: "expense", currency: "ILS", isPlaceholder: false, updatedAt: NOW },
  ];
  return book;
}

describe("editing a rule restates unposted history", () => {
  // "A changed amount reaches unposted history. The rule holds one amount and no history
  // of it, so raising the rent in September also restates June's still-unposted
  // occurrence." The rule keeps exactly one amount; whichever template is current at post
  // time is what a still-pending past occurrence gets posted under.
  it("posts a still-pending past occurrence at the rule's current amount, not its original one", () => {
    const monthly = {
      id: "r1",
      description: "Rent",
      fromAccountId: "bank",
      lines: [{ toAccountId: "rent", amount: 300000 }],
      every: 1,
      unit: "month" as const,
      startDate: "2026-01-01",
      endDate: null,
    };
    let book = unwrap(createRecurrence(seeded(), monthly, NOW));

    // Today is September; June's occurrence became due months ago and was never posted.
    const today = "2026-09-06";
    expect(dueOccurrences(book, today).map((o) => o.date)).toContain("2026-06-01");

    // The rent is raised — an ordinary two-field edit, same id, same schedule.
    book = unwrap(
      updateRecurrence(
        book,
        { ...monthly, id: "r1", lines: [{ toAccountId: "rent", amount: 320000 }] },
        LATER,
      ),
    );

    // June is still offered — the amount change did not touch the queue.
    expect(dueOccurrences(book, today).map((o) => o.date)).toContain("2026-06-01");

    // Confirming it now (exactly what the service layer's postOccurrence does: build the
    // entry from the rule's *current* template) restates June at the raised amount.
    const rule = book.recurrences[0];
    const posted = unwrap(
      postEntry(
        book,
        {
          id: recurrenceEntryId("r1", "2026-06-01"),
          date: "2026-06-01",
          description: rule.description,
          postings: [
            { accountId: "rent", side: "debit", amount: rule.lines[0].amount },
            { accountId: "bank", side: "credit", amount: rule.lines[0].amount },
          ],
        },
        LATER,
      ),
    );
    const entry = posted.journal.find((e) => e.id === recurrenceEntryId("r1", "2026-06-01"))!;
    expect(entry.postings.find((p) => p.side === "debit")!.amount).toBe(320000);
  });
});

describe("editing a rule's schedule can resurface a paid date", () => {
  // "A changed schedule can resurface paid dates. New dates mean new ids, and the old ids
  // no longer suppress anything." The already-posted entry keeps its own id and stays
  // suppressed — but the new schedule derives its own set of occurrence dates, and nothing
  // reconciles those against a period the old schedule already collected. A monthly rule
  // switched to weekly on the same startDate posts January once, then reoffers three more
  // dates that fall inside the month already paid for.
  it("keeps the posted date suppressed but offers new dates inside the same already-paid period", () => {
    const monthly = {
      id: "r1",
      description: "Rent",
      fromAccountId: "bank",
      lines: [{ toAccountId: "rent", amount: 100000 }],
      every: 1,
      unit: "month" as const,
      startDate: "2026-01-01",
      endDate: null,
    };
    let book = unwrap(createRecurrence(seeded(), monthly, NOW));

    // January is paid.
    book = unwrap(
      postEntry(
        book,
        {
          id: recurrenceEntryId("r1", "2026-01-01"),
          date: "2026-01-01",
          description: "Rent",
          postings: [
            { accountId: "rent", side: "debit", amount: 100000 },
            { accountId: "bank", side: "credit", amount: 100000 },
          ],
        },
        NOW,
      ),
    );

    // The rule is edited to a weekly schedule, keeping the same startDate rather than
    // accepting the app's "next future occurrence" default — the override the spec calls
    // out as the one that leaves already-paid dates visible rather than papering over them.
    book = unwrap(
      updateRecurrence(book, { ...monthly, id: "r1", every: 1, unit: "week" }, LATER),
    );

    const today = "2026-02-01";
    const due = dueOccurrences(book, today).map((o) => o.date);

    // The posted date's own id still suppresses it...
    expect(due).not.toContain("2026-01-01");
    // ...but the new weekly schedule derives its own ids for the other three occurrences
    // it finds in January, and nothing ties those back to the payment already made that
    // month.
    expect(due).toEqual(["2026-01-08", "2026-01-15", "2026-01-22", "2026-01-29"]);
  });
});
