import "fake-indexeddb/auto";
import { createIndexedDbRepository } from "../../src/adapters/indexeddb-repository";
import { importJson } from "../../src/adapters/import-book";
import { createBook } from "../../src/kernel/create-book";
import { bookToJson } from "../../src/adapters/json-codec";
import { NOW, unwrap, unwrapErr } from "../helpers";
import type { Book } from "../../src/kernel/types";

describe("IndexedDbRepository", () => {
  it("load returns null when empty", async () => {
    const repo = createIndexedDbRepository("khesh-test-empty");
    const loaded = unwrap(await repo.load());
    expect(loaded).toBeNull();
  });

  it("save then load returns the same book", async () => {
    const repo = createIndexedDbRepository("khesh-test-roundtrip");
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    unwrap(await repo.save(book));
    expect(unwrap(await repo.load())).toEqual(book);
  });

  it("failed import does not overwrite existing snapshot", async () => {
    const repo = createIndexedDbRepository("khesh-test-import");
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    unwrap(await repo.save(book));
    const failed = unwrapErr(await importJson(repo, "not-json"));
    expect(failed.code).toBe("JSON_PARSE_FAILED");
    expect(unwrap(await repo.load())).toEqual(book);
    unwrap(
      await importJson(
        repo,
        bookToJson(unwrap(createBook({ name: "Other", homeCurrency: "USD" }, NOW))),
      ),
    );
    expect(unwrap(await repo.load())?.name).toBe("Other");
  });

  it("loads a pre-budget snapshot with an empty budget list", async () => {
    const repo = createIndexedDbRepository("khesh-test-legacy-budgets");
    const legacy = {
      schemaVersion: 1,
      name: "Home",
      homeCurrency: "ILS",
      accounts: [],
      journal: [],
    };
    unwrap(await repo.save(legacy as unknown as Book));
    expect(unwrap(await repo.load())?.budgets).toEqual([]);
  });

  it("refuses a snapshot from a newer schema instead of downgrading it", async () => {
    const repo = createIndexedDbRepository("khesh-test-future-schema");
    const future = {
      schemaVersion: 4,
      name: "Home",
      homeCurrency: "ILS",
      metaUpdatedAt: NOW,
      accounts: [],
      journal: [],
      budgets: [],
      recurrences: [],
      tombstones: [],
      fieldThisBuildCannotSee: "keep me",
    };
    unwrap(await repo.save(future as unknown as Book));
    expect(unwrapErr(await repo.load()).code).toBe("BOOK_INVALID");
  });

  it("a stored record with no accounts array fails as a broken book, not broken storage", async () => {
    const repo = createIndexedDbRepository("khesh-test-no-accounts");
    const noAccounts = {
      schemaVersion: 1,
      name: "Home",
      homeCurrency: "ILS",
      journal: [],
    };
    unwrap(await repo.save(noAccounts as unknown as Book));
    // normalizeBook throws on this shape (accounts.map with no accounts array). Storage
    // itself read fine, so this must not come back as STORAGE_UNAVAILABLE — that would
    // route the recovery screen to the branch whose only action (Retry) re-reads this
    // same record and fails identically, leaving no way out.
    expect(unwrapErr(await repo.load()).code).toBe("BOOK_INVALID");
  });

  it("a stored null fails as a broken book, not broken storage", async () => {
    const repo = createIndexedDbRepository("khesh-test-stored-null");
    unwrap(await repo.save(null as unknown as Book));
    expect(unwrapErr(await repo.load()).code).toBe("BOOK_INVALID");
  });

  it("clear removes the saved book", async () => {
    const repo = createIndexedDbRepository("khesh-test-clear");
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    unwrap(await repo.save(book));
    unwrap(await repo.clear());
    expect(unwrap(await repo.load())).toBeNull();
  });

  it("clear succeeds when there is nothing stored, so a second reset is not an error", async () => {
    const repo = createIndexedDbRepository("khesh-test-clear-empty");
    unwrap(await repo.clear());
    unwrap(await repo.clear());
    expect(unwrap(await repo.load())).toBeNull();
  });
});
