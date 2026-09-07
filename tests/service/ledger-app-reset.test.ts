import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { createLedgerApp } from "../../src/service/ledger-app";
import { err, ok } from "../../src/kernel/result";
import type { LedgerRepository } from "../../src/ports/ledger-repository";
import { unwrap, unwrapErr } from "../helpers";

async function seeded() {
  const repo = createMemoryRepository(null);
  const app = createLedgerApp(repo);
  unwrap(await app.createHousehold("USD"));
  return { app, repo };
}

describe("LedgerApp resetAll", () => {
  it("removes the stored book", async () => {
    const { app, repo } = await seeded();
    unwrap(await app.resetAll());
    expect(unwrap(await repo.load())).toBeNull();
  });

  it("leaves boot with nothing to load, which is what returns the app to onboarding", async () => {
    const { app } = await seeded();
    unwrap(await app.resetAll());
    expect(unwrap(await app.boot())).toBeNull();
  });

  it("propagates a repository failure instead of reporting a reset that did not happen", async () => {
    const failing: LedgerRepository = {
      async load() {
        return ok(null);
      },
      async save() {
        return ok(undefined);
      },
      async clear() {
        return err("STORAGE_WRITE_FAILED", "disk full");
      },
    };
    const app = createLedgerApp(failing);
    expect(unwrapErr(await app.resetAll()).code).toBe("STORAGE_WRITE_FAILED");
  });

  it("does not fire afterCommit: a reset has no book to offer Drive", async () => {
    const repo = createMemoryRepository(null);
    let commits = 0;
    const app = createLedgerApp(repo, {
      afterCommit: () => {
        commits += 1;
      },
    });
    unwrap(await app.createHousehold("USD"));
    commits = 0;
    unwrap(await app.resetAll());
    expect(commits).toBe(0);
  });

  it("takes the same lock as every other write", async () => {
    const repo = createMemoryRepository(null);
    const order: string[] = [];
    const app = createLedgerApp(repo, {
      runExclusive: async (fn) => {
        order.push("locked");
        const result = await fn();
        order.push("released");
        return result;
      },
    });
    unwrap(await app.createHousehold("USD"));
    order.length = 0;
    unwrap(await app.resetAll());
    expect(order).toEqual(["locked", "released"]);
  });
});
