import { err, ok, type Result } from "../kernel/result";
import type { Account, Book, Budget, JournalEntry, Posting, Recurrence } from "../kernel/types";
import { validateBook } from "../kernel/validate";
import { normalizeBook, type StoredBook } from "../kernel/normalize";

const ACCOUNT_TYPES = new Set<Account["type"]>([
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
]);
const POSTING_SIDES = new Set<Posting["side"]>(["debit", "credit"]);
const JOURNAL_KINDS = new Set<JournalEntry["kind"]>(["standard", "opening"]);
const BUDGET_PERIODS = new Set<Budget["period"]>(["month", "year"]);
const RECURRENCE_UNITS = new Set<Recurrence["unit"]>(["week", "month", "year"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAccountShape(value: unknown): value is Account {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    (value.parentId === null || typeof value.parentId === "string") &&
    typeof value.name === "string" &&
    typeof value.type === "string" &&
    ACCOUNT_TYPES.has(value.type as Account["type"]) &&
    typeof value.currency === "string" &&
    typeof value.isPlaceholder === "boolean" &&
    (value.updatedAt === undefined || typeof value.updatedAt === "string")
  );
}

function isPostingShape(value: unknown): value is Posting {
  if (!isObject(value)) return false;
  return (
    typeof value.accountId === "string" &&
    typeof value.side === "string" &&
    POSTING_SIDES.has(value.side as Posting["side"]) &&
    typeof value.amount === "number"
  );
}

function isJournalEntryShape(value: unknown): value is JournalEntry {
  if (!isObject(value)) return false;
  if (
    typeof value.id !== "string" ||
    typeof value.date !== "string" ||
    typeof value.description !== "string" ||
    typeof value.kind !== "string" ||
    !JOURNAL_KINDS.has(value.kind as JournalEntry["kind"]) ||
    !Array.isArray(value.postings) ||
    !(value.updatedAt === undefined || typeof value.updatedAt === "string")
  ) {
    return false;
  }
  return value.postings.every(isPostingShape);
}

function isBudgetShape(value: unknown): value is Budget {
  if (!isObject(value)) return false;
  return (
    typeof value.accountId === "string" &&
    typeof value.period === "string" &&
    BUDGET_PERIODS.has(value.period as Budget["period"]) &&
    typeof value.currency === "string" &&
    typeof value.limit === "number" &&
    (value.updatedAt === undefined || typeof value.updatedAt === "string")
  );
}

function isRecurrenceShape(value: unknown): value is Recurrence {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.description === "string" &&
    typeof value.fromAccountId === "string" &&
    Array.isArray(value.lines) &&
    value.lines.every(
      (line: unknown) =>
        isObject(line) && typeof line.toAccountId === "string" && typeof line.amount === "number",
    ) &&
    typeof value.every === "number" &&
    typeof value.unit === "string" &&
    RECURRENCE_UNITS.has(value.unit as Recurrence["unit"]) &&
    typeof value.startDate === "string" &&
    (value.endDate === null || typeof value.endDate === "string") &&
    (value.pausedAt === null || typeof value.pausedAt === "string") &&
    Array.isArray(value.skipped) &&
    Array.isArray(value.deferred) &&
    (value.updatedAt === undefined || typeof value.updatedAt === "string")
  );
}

/** A v1, v2 or v3 file all pass here; `jsonToBook` gates the version itself. */
function isBookShape(value: unknown): value is StoredBook {
  if (!isObject(value)) return false;
  return (
    "schemaVersion" in value &&
    typeof value.name === "string" &&
    typeof value.homeCurrency === "string" &&
    Array.isArray(value.accounts) &&
    value.accounts.every(isAccountShape) &&
    Array.isArray(value.journal) &&
    value.journal.every(isJournalEntryShape) &&
    (!("budgets" in value) || (Array.isArray(value.budgets) && value.budgets.every(isBudgetShape))) &&
    (!("recurrences" in value) ||
      (Array.isArray(value.recurrences) && value.recurrences.every(isRecurrenceShape)))
  );
}

export function bookToJson(book: Book): string {
  return JSON.stringify(book);
}

export function jsonToBook(raw: string): Result<Book> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err("JSON_PARSE_FAILED", "JSON parse failed");
  }
  if (!isBookShape(parsed)) {
    return err("JSON_INVALID_BOOK", "JSON is not a Book snapshot");
  }
  if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3) {
    return err("BOOK_INVALID_SCHEMA_VERSION", `Unsupported schemaVersion ${String(parsed.schemaVersion)}`, {
      schemaVersion: parsed.schemaVersion,
    });
  }
  const book = normalizeBook(parsed);
  const validated = validateBook(book);
  if (!validated.ok) return validated;
  return ok(book);
}
