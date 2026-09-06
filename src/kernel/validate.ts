import { siblingNameTaken, wouldCreateCycle } from "./book-utils";
import { isCurrencyCode } from "./currency";
import { isCalendarDate } from "./dates";
import { validatePostings } from "./entry-validation";
import type { LedgerError } from "./errors";
import { err, ok, type Result } from "./result";
import { budgetKeyOf } from "./tombstones";
import type { Account, AccountType, Book, JournalEntryKind, PostingSide } from "./types";

const ACCOUNT_TYPES = new Set<AccountType>([
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
]);
const POSTING_SIDES = new Set<PostingSide>(["debit", "credit"]);
const JOURNAL_KINDS = new Set<JournalEntryKind>(["standard", "opening"]);
const TOMBSTONE_KINDS = new Set<string>(["account", "entry", "budget"]);

function isAccountRecord(value: unknown): value is Account {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateBook(book: Book): Result<true> {
  const violations: LedgerError[] = [];

  if (book.schemaVersion !== 2) {
    violations.push({
      code: "BOOK_INVALID_SCHEMA_VERSION",
      message: `Unsupported schemaVersion ${String(book.schemaVersion)}`,
      details: { schemaVersion: book.schemaVersion },
    });
  }
  if (typeof book.metaUpdatedAt !== "string") {
    violations.push({ code: "BOOK_INVALID", message: "Book metaUpdatedAt must be a string" });
  }
  if (typeof book.name !== "string" || book.name.trim().length === 0) {
    violations.push({ code: "BOOK_NAME_INVALID", message: "Book name must be non-empty" });
  }
  if (!isCurrencyCode(book.homeCurrency)) {
    violations.push({
      code: "INVALID_CURRENCY_CODE",
      message: `Invalid homeCurrency ${String(book.homeCurrency)}`,
    });
  }

  // Every scan below — and every book-utils helper they reach — assumes these two
  // are arrays, the way the budgets and tombstones blocks assume theirs. Bail out
  // with what we have rather than iterate a non-array: nothing downstream can be
  // checked without an account list anyway, and validateBook must return a Result.
  if (!Array.isArray(book.accounts) || !Array.isArray(book.journal)) {
    if (!Array.isArray(book.accounts)) {
      violations.push({ code: "BOOK_INVALID", message: "Book accounts must be an array" });
    }
    if (!Array.isArray(book.journal)) {
      violations.push({ code: "BOOK_INVALID", message: "Book journal must be an array" });
    }
    return err("BOOK_INVALID", "Book failed validation", { violations });
  }

  // `${kind}|${key}` of every live record, collected as each loop below clears its
  // element guard, so the tombstone pass never dereferences an element the loops
  // already rejected. validateBook must return a Result, never throw.
  const liveKeys = new Set<string>();

  const ids = new Set<string>();
  for (const account of book.accounts) {
    if (!isAccountRecord(account)) {
      violations.push({ code: "BOOK_INVALID", message: "Invalid account element" });
      continue;
    }
    liveKeys.add(`account|${String(account.id)}`);
    if (ids.has(account.id)) {
      violations.push({
        code: "ACCOUNT_ID_DUPLICATE",
        message: `Duplicate account id ${account.id}`,
        details: { id: account.id },
      });
    }
    ids.add(account.id);
    if (typeof account.updatedAt !== "string") {
      violations.push({
        code: "BOOK_INVALID",
        message: "Record missing updatedAt",
        details: { id: account.id },
      });
    }
    if (typeof account.name !== "string" || account.name.trim().length === 0) {
      violations.push({
        code: "ACCOUNT_NAME_INVALID",
        message: "Account name must be non-empty",
        details: { id: account.id },
      });
    }
    if (!ACCOUNT_TYPES.has(account.type)) {
      violations.push({
        code: "BOOK_INVALID",
        message: `Invalid account type ${String(account.type)}`,
        details: { id: account.id },
      });
    }
    if (!isCurrencyCode(account.currency)) {
      violations.push({
        code: "INVALID_CURRENCY_CODE",
        message: `Invalid account currency ${String(account.currency)}`,
        details: { id: account.id },
      });
    }
    if (account.parentId !== null) {
      const parent = book.accounts.find((item) => isAccountRecord(item) && item.id === account.parentId);
      if (!parent) {
        violations.push({
          code: "ACCOUNT_PARENT_INVALID",
          message: "Parent account not found",
          details: { id: account.id, parentId: account.parentId },
        });
      } else {
        if (!parent.isPlaceholder) {
          violations.push({
            code: "ACCOUNT_PARENT_NOT_PLACEHOLDER",
            message: "Only placeholder accounts may have children",
            details: { id: account.id },
          });
        }
        if (parent.type !== account.type) {
          violations.push({
            code: "ACCOUNT_TYPE_MISMATCH",
            message: "Child type must match parent type",
            details: { id: account.id },
          });
        }
        if (wouldCreateCycle(book, account.id, account.parentId)) {
          violations.push({
            code: "ACCOUNT_CYCLE",
            message: "Account parent cycle",
            details: { id: account.id },
          });
        }
      }
    }
    if (siblingNameTaken(book, account.parentId, account.name, account.id)) {
      violations.push({
        code: "ACCOUNT_NAME_DUPLICATE",
        message: "Account name already used among siblings",
        details: { id: account.id, name: account.name },
      });
    }
  }

  const entryIds = new Set<string>();
  for (const entry of book.journal) {
    if (!entry || typeof entry !== "object") {
      violations.push({ code: "BOOK_INVALID", message: "Invalid journal entry element" });
      continue;
    }
    liveKeys.add(`entry|${String(entry.id)}`);
    if (entryIds.has(entry.id)) {
      violations.push({
        code: "ENTRY_ID_DUPLICATE",
        message: `Duplicate journal id ${entry.id}`,
        details: { id: entry.id },
      });
    }
    entryIds.add(entry.id);
    if (typeof entry.updatedAt !== "string") {
      violations.push({
        code: "BOOK_INVALID",
        message: "Record missing updatedAt",
        details: { id: entry.id },
      });
    }
    if (!isCalendarDate(entry.date)) {
      violations.push({
        code: "ENTRY_DATE_INVALID",
        message: `Invalid date ${entry.date}`,
        details: { id: entry.id },
      });
    }
    if (!JOURNAL_KINDS.has(entry.kind)) {
      violations.push({
        code: "BOOK_INVALID",
        message: `Invalid entry kind ${String(entry.kind)}`,
        details: { id: entry.id },
      });
      continue;
    }
    if (!Array.isArray(entry.postings)) {
      violations.push({
        code: "BOOK_INVALID",
        message: "Journal entry missing postings array",
        details: { id: entry.id },
      });
      continue;
    }
    let postingsWellShaped = true;
    for (const posting of entry.postings) {
      if (!posting || typeof posting !== "object") {
        violations.push({
          code: "BOOK_INVALID",
          message: "Invalid posting element",
          details: { id: entry.id },
        });
        postingsWellShaped = false;
        continue;
      }
      if (!POSTING_SIDES.has(posting.side)) {
        violations.push({
          code: "BOOK_INVALID",
          message: `Invalid posting side ${String(posting.side)}`,
          details: { id: entry.id },
        });
      }
    }
    // validatePostings dereferences every element, so it may only see well-shaped
    // ones — this is the single call site that can be handed unvalidated data, and
    // the loop above already knows which elements are bad. The whole check is
    // skipped rather than run on the survivors: dropping a posting from a
    // double-entry transaction unbalances it by construction, so a balance verdict
    // on a partial array would assert an imbalance we cannot actually know, on top
    // of the corruption already recorded.
    if (postingsWellShaped) {
      const postingCheck = validatePostings(book, entry.postings, entry.kind, entry.fx);
      if (!postingCheck.ok) {
        violations.push(postingCheck.error);
      }
    }
  }

  if (!Array.isArray(book.budgets)) {
    violations.push({ code: "BOOK_INVALID", message: "Book budgets must be an array" });
  } else {
    const budgetKeys = new Set<string>();
    for (const budget of book.budgets) {
      if (!budget || typeof budget !== "object") {
        violations.push({ code: "BOOK_INVALID", message: "Invalid budget element" });
        continue;
      }
      if (typeof budget.updatedAt !== "string") {
        violations.push({
          code: "BOOK_INVALID",
          message: "Record missing updatedAt",
          details: { accountId: budget.accountId },
        });
      }
      const account = book.accounts.find(
        (item) => isAccountRecord(item) && item.id === budget.accountId,
      );
      if (!account) {
        violations.push({
          code: "ACCOUNT_NOT_FOUND",
          message: "Budget references a missing account",
          details: { accountId: budget.accountId },
        });
      } else if (account.type !== "expense") {
        violations.push({
          code: "ACCOUNT_TYPE_MISMATCH",
          message: "Budgets cover expense accounts only",
          details: { accountId: budget.accountId },
        });
      }
      if (budget.period !== "month" && budget.period !== "year") {
        violations.push({
          code: "BOOK_INVALID",
          message: `Invalid budget period ${String(budget.period)}`,
          details: { accountId: budget.accountId },
        });
      }
      if (!isCurrencyCode(budget.currency)) {
        violations.push({
          code: "INVALID_CURRENCY_CODE",
          message: `Invalid budget currency ${String(budget.currency)}`,
          details: { accountId: budget.accountId },
        });
      }
      if (!Number.isInteger(budget.limit) || budget.limit <= 0) {
        violations.push({
          code: "BUDGET_LIMIT_INVALID",
          message: "Limit must be an integer greater than zero",
          details: { accountId: budget.accountId, limit: budget.limit },
        });
      }
      const key = budgetKeyOf(budget);
      liveKeys.add(`budget|${key}`);
      if (budgetKeys.has(key)) {
        violations.push({
          code: "BUDGET_DUPLICATE",
          message: "Duplicate budget for the same account, period and currency",
          details: { accountId: budget.accountId },
        });
      }
      budgetKeys.add(key);
    }
  }

  if (!Array.isArray(book.tombstones)) {
    violations.push({ code: "BOOK_INVALID", message: "Book tombstones must be an array" });
  } else {
    for (const stone of book.tombstones) {
      if (
        !stone ||
        typeof stone !== "object" ||
        !TOMBSTONE_KINDS.has(stone.kind) ||
        typeof stone.key !== "string" ||
        typeof stone.deletedAt !== "string" ||
        typeof stone.record !== "object" ||
        stone.record === null
      ) {
        violations.push({ code: "BOOK_INVALID", message: "Invalid tombstone element" });
        continue;
      }
      if (liveKeys.has(`${stone.kind}|${stone.key}`)) {
        violations.push({
          code: "BOOK_INVALID",
          message: "Tombstone shadows a live record",
          details: { kind: stone.kind, key: stone.key },
        });
      }
    }
  }

  if (violations.length > 0) {
    return err("BOOK_INVALID", "Book failed validation", { violations });
  }
  return ok(true);
}
