import { occurrencesBetween, shiftMonths } from "../kernel/recurrence-dates";
import type { Book, CurrencyCode, MinorUnits, Recurrence } from "../kernel";

export type RuleRow = {
  id: string;
  description: string;
  total: MinorUnits;
  currency: CurrencyCode;
  every: number;
  unit: Recurrence["unit"];
  next: string | null;
  paused: boolean;
};

/**
 * The first occurrence strictly after `today`, or null when the rule is paused or has run
 * out. Looked for inside one interval past today — a schedule cannot skip its own step —
 * so this stays O(1) whatever the interval.
 */
export function nextOccurrence(rule: Recurrence, today: string): string | null {
  if (rule.pausedAt !== null) return null;
  const horizon = shiftMonths(today, 12 * rule.every + 12);
  const to = rule.endDate !== null && rule.endDate < horizon ? rule.endDate : horizon;
  const dates = occurrencesBetween(rule.startDate, rule.every, rule.unit, today, to);
  const after = dates.find((date) => date > today);
  return after ?? null;
}

export function ruleRows(book: Book, today: string): RuleRow[] {
  return book.recurrences
    .map((rule) => ({
      id: rule.id,
      description: rule.description,
      total: rule.lines.reduce((sum, line) => sum + line.amount, 0) as MinorUnits,
      currency:
        book.accounts.find((a) => a.id === rule.fromAccountId)?.currency ?? book.homeCurrency,
      every: rule.every,
      unit: rule.unit,
      next: nextOccurrence(rule, today),
      paused: rule.pausedAt !== null,
    }))
    .sort((a, b) => a.description.localeCompare(b.description));
}
