import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../src/app/i18n";
import { createMemoryRepository } from "../../src/adapters/memory-repository";
import { holdsNoUserData } from "../../src/kernel/book-utils";
import { validateBook } from "../../src/kernel";
import { applyOption, EMPTY_ANSWERS } from "../../src/app/onboarding/questionnaire";
import { planStarterBook, rootsPlan } from "../../src/service/starter-plan";
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

  /* The seed is what `localState` reads as "empty", and that reading is what keeps merge
   * away from a second device's first connect: local `"empty"` never offers it, because
   * merging a seed against a real book doubles the roots (BL-048). `holdsNoUserData` has
   * its own suite, but every case there builds its book by hand — so a `createHousehold`
   * that grew a nested group or a non-placeholder root would make this false, bring merge
   * back to second-device setup, and leave that suite green. Assert the two together. */
  it("createHousehold produces a book that holds no user data", async () => {
    const app = createLedgerApp(createMemoryRepository(null));
    expect(holdsNoUserData(unwrap(await app.createHousehold("ILS")))).toBe(true);
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

  it("createHousehold with a plan creates every account under its parent, in one commit", async () => {
    const repo = createMemoryRepository(null);
    const commits: number[] = [];
    const app = createLedgerApp(repo, { afterCommit: (b) => commits.push(b.accounts.length) });
    let answers = applyOption(EMPTY_ANSWERS, "household", "family");
    answers = applyOption(answers, "childAges", "school");
    answers = applyOption(answers, "money", "bank");
    answers = applyOption(answers, "money", "card");
    answers = applyOption(answers, "cardCount", "2");
    const plan = planStarterBook(answers, "ILS");

    const book = unwrap(await app.createHousehold("ILS", plan));

    expect(book.accounts).toHaveLength(plan.length);
    expect(commits).toEqual([plan.length]);
    expect(validateBook(book).ok).toBe(true);
    // The starter.accounts.* i18n strings don't exist yet (Task 4), so identify each
    // created account by its plan position rather than its resolved name: createAccount
    // pushes to the end of book.accounts, and every plan item here is created
    // successfully, so book.accounts[i] is the account minted from plan[i].
    const byKey = new Map(plan.map((item, i) => [item.key, book.accounts[i]]));
    const expenses = byKey.get("expenses")!;
    const children = byKey.get("children")!;
    expect(children).toMatchObject({ parentId: expenses.id, isPlaceholder: true, type: "expense" });
    expect(byKey.get("school")).toMatchObject({ parentId: children.id, isPlaceholder: false });
    expect(byKey.get("card2")).toMatchObject({ type: "liability", currency: "ILS" });
    expect(unwrap(await repo.load())?.accounts).toHaveLength(plan.length);
  });

  it("createHousehold rejects a plan whose parent is not created first", async () => {
    const app = createLedgerApp(createMemoryRepository(null));
    const broken = [...rootsPlan("ILS")].reverse();
    broken.push({ key: "x", parentKey: "nope", nameKey: "starter.accounts.cash", type: "asset", isPlaceholder: false, currency: "ILS" });
    expect(unwrapErr(await app.createHousehold("ILS", broken)).code).toBe("ACCOUNT_PARENT_INVALID");
  });

  it("createHousehold resolves plan names in the current language", async () => {
    await i18n.changeLanguage("he");
    const app = createLedgerApp(createMemoryRepository(null));
    const answers = applyOption(applyOption(EMPTY_ANSWERS, "household", "solo"), "money", "cash");
    const book = unwrap(await app.createHousehold("ILS", planStarterBook(answers, "ILS")));
    expect(book.accounts.some((a) => a.name === i18n.t("starter.accounts.cash"))).toBe(true);
    expect(book.accounts.some((a) => a.name === "Cash")).toBe(false);
  });

  // Before these strings existed, two credit-card entries both carried the raw key
  // `starter.accounts.creditCardN` (i18next's fallback when no translation is present),
  // so they collided on the kernel's sibling-name-uniqueness rule and a plan with more
  // than one credit card could not be created at all. This proves the interpolated
  // strings now resolve to distinct names for three cards.
  it("createHousehold creates three credit cards with three distinct names", async () => {
    let answers = applyOption(EMPTY_ANSWERS, "household", "solo");
    answers = applyOption(answers, "money", "card");
    answers = applyOption(answers, "cardCount", "3");
    const app = createLedgerApp(createMemoryRepository(null));
    const book = unwrap(await app.createHousehold("ILS", planStarterBook(answers, "ILS")));
    const cards = book.accounts.filter((a) => a.type === "liability" && !a.isPlaceholder);
    expect(cards).toHaveLength(3);
    expect(new Set(cards.map((a) => a.name)).size).toBe(3);
  });
});
