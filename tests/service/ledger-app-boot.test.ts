import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../src/app/i18n";
import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { createLedgerApp, HOUSEHOLD_BOOK_NAME, ROOT_SEEDS } from "../../src/service/ledger-app";
import { unwrap, unwrapErr } from "../helpers";

describe("LedgerApp boot + createHousehold", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("boot returns null when storage empty", async () => {
    const app = createLedgerApp(createMemoryRepository(null));
    expect(unwrap(await app.boot())).toBeNull();
  });

  it("createHousehold seeds four placeholder roots and persists", async () => {
    const repo = createMemoryRepository(null);
    const app = createLedgerApp(repo);
    const book = unwrap(await app.createHousehold("ILS"));
    expect(book.name).toBe(HOUSEHOLD_BOOK_NAME);
    expect(book.homeCurrency).toBe("ILS");
    const roots = book.accounts.filter((a) => a.parentId === null);
    expect(roots).toHaveLength(4);
    for (const seed of ROOT_SEEDS) {
      const root = roots.find((a) => a.name === seed.name);
      expect(root).toMatchObject({
        type: seed.type,
        isPlaceholder: true,
        currency: "ILS",
      });
    }
    expect(unwrap(await repo.load())?.accounts).toHaveLength(4);
    expect(unwrap(await app.boot())?.homeCurrency).toBe("ILS");
  });

  it("createHousehold rejects invalid currency", async () => {
    const app = createLedgerApp(createMemoryRepository(null));
    expect(unwrapErr(await app.createHousehold("il")).code).toBe("INVALID_CURRENCY_CODE");
  });

  it("seeds root account names in the active language", async () => {
    await i18n.changeLanguage("he");
    const app = createLedgerApp(createMemoryRepository(null));
    const book = unwrap(await app.createHousehold("ILS"));
    const rootNames = book.accounts.filter((a) => a.parentId === null).map((a) => a.name);
    expect(rootNames.sort()).toEqual(
      ["נכסים", "התחייבויות", "הכנסות", "הוצאות"].sort(),
    );
  });
});
