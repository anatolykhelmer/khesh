import { buildDemoBook } from "../../scripts/demo-book.ts";
import { dueOccurrences } from "../../src/kernel/occurrences";
import { budgetReport, periodTotals } from "../../src/kernel/queries";
import { validateBook } from "../../src/kernel/validate";
import { unwrap } from "../helpers";

const TODAY = "2026-09-14";
const MONTH = { from: "2026-09-01", to: "2026-09-30" };

describe("buildDemoBook", () => {
  it("produces a book the kernel considers valid", () => {
    unwrap(validateBook(buildDemoBook(TODAY)));
  });

  it("holds a populated tree in USD with one EUR account", () => {
    const book = buildDemoBook(TODAY);
    expect(book.homeCurrency).toBe("USD");
    const leaves = book.accounts.filter((account) => !account.isPlaceholder);
    expect(leaves.length).toBeGreaterThanOrEqual(12);
    expect(leaves.filter((account) => account.currency === "EUR")).toHaveLength(1);
  });

  it("carries a split entry and a cross-currency entry", () => {
    const book = buildDemoBook(TODAY);
    expect(book.journal.some((entry) => entry.postings.length > 2)).toBe(true);
    expect(book.journal.some((entry) => entry.fx !== undefined)).toBe(true);
  });

  it("shows money moving in the month being photographed", () => {
    const totals = unwrap(periodTotals(buildDemoBook(TODAY), MONTH));
    expect(totals.USD.income).toBeGreaterThan(0);
    expect(totals.USD.expense).toBeGreaterThan(0);
  });

  it("leaves every budget partway spent, never empty and never blown", () => {
    const report = unwrap(budgetReport(buildDemoBook(TODAY), "month", MONTH));
    expect(report.rows.length).toBeGreaterThanOrEqual(5);
    for (const row of report.rows) {
      expect(row.spent).toBeGreaterThan(0);
      expect(row.spent).toBeLessThan(row.limit);
    }
  });

  it("carries two recurring bills", () => {
    const book = buildDemoBook(TODAY);
    expect(book.recurrences).toHaveLength(2);
  });

  it("has at least one recurrence due for the photographed month", () => {
    // Against the kernel's own due-row query, not a recomputed schedule: this fails if the
    // Dashboard's recurring-payments queue would actually render empty.
    const due = dueOccurrences(buildDemoBook(TODAY), TODAY);
    expect(due.length).toBeGreaterThanOrEqual(1);
    for (const occurrence of due) {
      expect(occurrence.date >= MONTH.from && occurrence.date <= MONTH.to).toBe(true);
    }
  });

  it("is stable for a given date", () => {
    const a = buildDemoBook(TODAY);
    const b = buildDemoBook(TODAY);
    expect(a.journal.map((entry) => [entry.date, entry.description])).toEqual(
      b.journal.map((entry) => [entry.date, entry.description]),
    );
  });
});
