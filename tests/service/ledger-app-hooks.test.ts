import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { createLedgerApp } from "../../src/service/ledger-app";
import type { Book } from "../../src/kernel";
import { NOW, unwrap } from "../helpers";

describe("ledger app hooks", () => {
  it("stamps with the injected clock and fires afterCommit on mutations and import", async () => {
    const repo = createMemoryRepository(null);
    const commits: Book[] = [];
    const app = createLedgerApp(repo, { now: () => NOW, afterCommit: (b) => commits.push(b) });

    const book = unwrap(await app.createHousehold("ILS"));
    expect(book.metaUpdatedAt).toBe(NOW);
    expect(book.accounts.every((a) => a.updatedAt === NOW)).toBe(true);
    expect(commits).toHaveLength(1);

    unwrap(await app.importJson(app.exportJson(book)));
    expect(commits).toHaveLength(2);
  });

  it("does not fire afterCommit when the mutation fails", async () => {
    const repo = createMemoryRepository(null);
    const commits: Book[] = [];
    const app = createLedgerApp(repo, { afterCommit: (b) => commits.push(b) });
    expect((await app.createHousehold("bad")).ok).toBe(false);
    expect(commits).toHaveLength(0);
  });
});
