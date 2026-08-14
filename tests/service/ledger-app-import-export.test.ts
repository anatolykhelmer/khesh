import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { createLedgerApp } from "../../src/service/ledger-app";
import { unwrap, unwrapErr } from "../helpers";

/** A household with one leaf account holding an opening balance. */
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
  return { app, repo, book: withCash };
}

describe("LedgerApp export / import", () => {
  it("round-trips a book through JSON into a fresh repository", async () => {
    const source = await seededBook();
    const raw = source.app.exportJson(source.book);

    const target = createLedgerApp(createMemoryRepository(null));
    const imported = unwrap(await target.importJson(raw));

    expect(imported).toEqual(source.book);
    expect(unwrap(await target.boot())).toEqual(source.book);
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
});
