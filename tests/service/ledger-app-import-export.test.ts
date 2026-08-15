import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { createLedgerApp } from "../../src/service/ledger-app";
import { err, ok } from "../../src/kernel/result";
import type { LedgerRepository } from "../../src/ports/ledger-repository";
import { unwrap, unwrapErr } from "../helpers";

/**
 * A household with one leaf account holding an opening balance, plus a
 * cross-currency transfer into a second leaf account so the fixture also
 * exercises `JournalEntry.fx`, the one optional field on `Book`.
 */
async function seededBook() {
  const repo = createMemoryRepository(null);
  const app = createLedgerApp(repo);
  const created = unwrap(await app.createHousehold("ILS"));
  const assets = created.accounts.find((a) => a.type === "asset" && a.parentId === null)!;
  const withCash = unwrap(
    await app.addAccount(created, {
      parentId: assets.id,
      name: "Cash",
      isPlaceholder: false,
      currency: "ILS",
      openingAmount: 12345,
      openingDate: "2026-08-01",
    }),
  );
  const cash = withCash.accounts.find((a) => a.name === "Cash")!;
  const withSavings = unwrap(
    await app.addAccount(withCash, {
      parentId: assets.id,
      name: "USD Savings",
      isPlaceholder: false,
      currency: "USD",
    }),
  );
  const savings = withSavings.accounts.find((a) => a.name === "USD Savings")!;
  const withTransfer = unwrap(
    await app.addEntry(withSavings, {
      date: "2026-08-05",
      description: "Buy dollars",
      fromAccountId: cash.id,
      fromAmount: 10000,
      lines: [{ toAccountId: savings.id, amount: 2700 }],
    }),
  );
  return { app, repo, book: withTransfer };
}

function createFailingSaveRepository(): LedgerRepository {
  return {
    async load() {
      return ok(null);
    },
    async save() {
      return err("STORAGE_WRITE_FAILED", "disk full");
    },
  };
}

describe("LedgerApp export / import", () => {
  it("round-trips a book through JSON into a fresh repository", async () => {
    const source = await seededBook();
    const raw = source.app.exportJson(source.book);

    const target = createLedgerApp(createMemoryRepository(null));
    const imported = unwrap(await target.importJson(raw));

    expect(imported).toEqual(source.book);
    expect(unwrap(await target.boot())).toEqual(source.book);

    // toEqual on the whole book already covers fx, but name the risk explicitly:
    // a stringify-by-field-projection regression could silently drop it.
    const sourceEntry = source.book.journal.find((e) => e.fx !== undefined)!;
    const importedEntry = imported.journal.find((e) => e.id === sourceEntry.id)!;
    expect(importedEntry.fx).toEqual(sourceEntry.fx);
  });

  it("rejects a file that is not JSON", async () => {
    const app = createLedgerApp(createMemoryRepository(null));
    expect(unwrapErr(await app.importJson("not json at all")).code).toBe("JSON_PARSE_FAILED");
  });

  it("rejects JSON that is not a book snapshot", async () => {
    const app = createLedgerApp(createMemoryRepository(null));
    expect(unwrapErr(await app.importJson('{"hello":"world"}')).code).toBe("JSON_INVALID_BOOK");
  });

  it("rejects a book written by another schema version", async () => {
    const source = await seededBook();
    const parsed = JSON.parse(source.app.exportJson(source.book)) as Record<string, unknown>;
    parsed.schemaVersion = 2;

    const app = createLedgerApp(createMemoryRepository(null));
    expect(unwrapErr(await app.importJson(JSON.stringify(parsed))).code).toBe(
      "BOOK_INVALID_SCHEMA_VERSION",
    );
  });

  it("leaves the stored book untouched when the import fails", async () => {
    const source = await seededBook();
    expect(unwrapErr(await source.app.importJson("{ broken")).code).toBe("JSON_PARSE_FAILED");
    expect(unwrap(await source.repo.load())).toEqual(source.book);
  });

  it("rejects a shape-valid file that violates a book invariant, leaving the stored book intact", async () => {
    const source = await seededBook();
    const parsed = JSON.parse(source.app.exportJson(source.book)) as Record<string, unknown>;
    const accounts = parsed.accounts as Record<string, unknown>[];
    // Duplicate an account id: still passes isBookShape (every element is a
    // well-formed account), but fails validateBook's uniqueness check.
    accounts.push({ ...accounts[0] });

    expect(unwrapErr(await source.app.importJson(JSON.stringify(parsed))).code).toBe(
      "BOOK_INVALID",
    );
    expect(unwrap(await source.repo.load())).toEqual(source.book);
  });

  it("surfaces STORAGE_WRITE_FAILED as an error Result when the repository save fails", async () => {
    const source = await seededBook();
    const raw = source.app.exportJson(source.book);

    const app = createLedgerApp(createFailingSaveRepository());
    expect(unwrapErr(await app.importJson(raw)).code).toBe("STORAGE_WRITE_FAILED");
  });
});
