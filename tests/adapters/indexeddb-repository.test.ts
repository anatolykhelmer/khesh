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
});
