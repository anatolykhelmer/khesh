import { err, ok, type Result } from "../kernel/result";
import type { Account, Book, JournalEntry, Posting } from "../kernel/types";
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

/** A v1 file and a v2 file both pass here; `jsonToBook` gates the version itself. */
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
    (!("budgets" in value) || Array.isArray(value.budgets))
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
  if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) {
    return err("BOOK_INVALID_SCHEMA_VERSION", `Unsupported schemaVersion ${String(parsed.schemaVersion)}`, {
      schemaVersion: parsed.schemaVersion,
    });
  }
  const book = normalizeBook(parsed);
  const validated = validateBook(book);
  if (!validated.ok) return validated;
  return ok(book);
}
