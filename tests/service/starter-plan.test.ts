import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createAccount, createBook, validateBook } from "../../src/kernel";
import {
  applyOption,
  EMPTY_ANSWERS,
  QUESTIONS,
  selectedOptions,
  type Answers,
  type QuestionId,
} from "../../src/app/onboarding/questionnaire";
import {
  planStarterBook,
  planTree,
  rootsPlan,
  type StarterAccount,
} from "../../src/service/starter-plan";
import { unwrap } from "../helpers";

/** Build a real Book from a plan the way createHousehold will: parents first, names
 * resolved to a stable string per key so sibling-uniqueness is checked on what the user
 * will actually see (two entries with the same nameKey+args under one parent collide). */
function realize(plan: readonly StarterAccount[], home: string) {
  let book = unwrap(createBook({ name: "Household", homeCurrency: home }, "2026-09-14T00:00:00.000Z"));
  const ids = new Map<string, string>();
  for (const item of plan) {
    const parentId = item.parentKey === null ? null : ids.get(item.parentKey);
    if (item.parentKey !== null && parentId === undefined) throw new Error(`parent ${item.parentKey} not yet created`);
    const name = item.nameKey + (item.nameArgs ? " " + JSON.stringify(item.nameArgs) : "");
    const before = new Set(book.accounts.map((x) => x.id));
    book = unwrap(createAccount(book, { parentId: parentId ?? null, name, type: item.type, currency: item.currency, isPlaceholder: item.isPlaceholder }, "2026-09-14T00:00:00.000Z"));
    ids.set(item.key, book.accounts.find((x) => !before.has(x.id))!.id);
  }
  return book;
}

/** Random answers built only through applyOption, so they are always answers the wizard
 * could actually produce (hidden follow-ups cleared, salary2 only when offered). */
const arbAnswers: fc.Arbitrary<Answers> = fc
  .array(fc.tuple(fc.nat(QUESTIONS.length - 1), fc.nat(9)), { maxLength: 40 })
  .map((taps) => {
    let a = EMPTY_ANSWERS;
    for (const [qi, oi] of taps) {
      const q = QUESTIONS[qi];
      if (!q.visibleWhen(a)) continue;
      const options = q.options(a, "ILS");
      a = applyOption(a, q.id, options[oi % options.length]);
    }
    return a;
  });

describe("planStarterBook", () => {
  it("is the four roots when nothing is answered or the household is skipped", () => {
    expect(planStarterBook(EMPTY_ANSWERS, "ILS")).toEqual(rootsPlan("ILS"));
    expect(planStarterBook(applyOption(EMPTY_ANSWERS, "household", "skip"), "ILS")).toEqual(rootsPlan("ILS"));
    const book = realize(rootsPlan("EUR"), "EUR");
    expect(book.accounts).toHaveLength(4);
    expect(book.accounts.every((a) => a.isPlaceholder && a.currency === "EUR")).toBe(true);
  });

  it("always realizes into a valid book with unique siblings and parents first", () => {
    fc.assert(
      fc.property(arbAnswers, fc.constantFrom("ILS", "USD", "EUR"), (a, home) => {
        const plan = planStarterBook(a, home);
        const keys = new Set<string>();
        for (const item of plan) {
          expect(keys.has(item.key), `duplicate key ${item.key}`).toBe(false);
          if (item.parentKey !== null) expect(keys.has(item.parentKey), `${item.key} before its parent`).toBe(true);
          keys.add(item.key);
        }
        const book = realize(plan, home);
        expect(validateBook(book).ok).toBe(true);
        expect(book.accounts.filter((x) => x.parentId === null)).toHaveLength(4);
      }),
      { numRuns: 300 },
    );
  });

  function names(plan: StarterAccount[], parentKey: string | null): string[] {
    return plan.filter((p) => p.parentKey === parentKey).map((p) => p.nameKey);
  }

  it("a family with school-age children gets a Children group with School and Activities", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "family");
    a = applyOption(a, "childAges", "school");
    const plan = planStarterBook(a, "ILS");
    expect(names(plan, "children")).toEqual([
      "starter.accounts.school",
      "starter.accounts.activities",
      "starter.accounts.childrenClothing",
    ]);
    expect(plan.find((p) => p.key === "children")).toMatchObject({ parentKey: "expenses", isPlaceholder: true, type: "expense" });
  });

  it("three credit cards are three numbered liabilities", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "solo");
    a = applyOption(a, "money", "card");
    a = applyOption(a, "cardCount", "3");
    const cards = planStarterBook(a, "ILS").filter((p) => p.parentKey === "liabilities");
    expect(cards.map((p) => [p.nameKey, p.nameArgs])).toEqual([
      ["starter.accounts.creditCard", undefined],
      ["starter.accounts.creditCardN", { n: 2 }],
      ["starter.accounts.creditCardN", { n: 3 }],
    ]);
    expect(cards.every((p) => p.type === "liability" && !p.isPlaceholder)).toBe(true);
  });

  it("fuel appears once when both an own and a leased car are chosen", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "solo");
    a = applyOption(a, "transport", "car");
    a = applyOption(a, "transport", "lease");
    const car = names(planStarterBook(a, "ILS"), "car");
    expect(car.filter((n) => n === "starter.accounts.fuel")).toHaveLength(1);
    expect(car).toContain("starter.accounts.lease");
  });

  it("mortgage is a liability plus an interest expense under Housing", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "couple");
    a = applyOption(a, "housing", "mortgage");
    const plan = planStarterBook(a, "ILS");
    expect(names(plan, "liabilities")).toContain("starter.accounts.mortgage");
    expect(names(plan, "housing")).toEqual([
      "starter.accounts.mortgageInterest",
      "starter.accounts.utilities",
      "starter.accounts.homeRepairs",
    ]);
  });

  it("living with family creates no housing group", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "solo");
    a = applyOption(a, "housing", "family");
    expect(planStarterBook(a, "ILS").some((p) => p.key === "housing")).toBe(false);
  });

  it("an account in another currency carries that currency", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "solo");
    a = applyOption(a, "money", "fx");
    a = applyOption(a, "fxCurrency", "USD");
    const fx = planStarterBook(a, "ILS").find((p) => p.key === "fx")!;
    expect(fx).toMatchObject({ parentKey: "assets", currency: "USD", nameKey: "starter.accounts.fxAccount", nameArgs: { currency: "USD" } });
  });

  it("groceries and other are always present for any real household", () => {
    for (const h of ["solo", "couple", "family"] as const) {
      const plan = planStarterBook(applyOption(EMPTY_ANSWERS, "household", h), "ILS");
      expect(names(plan, "expenses")).toContain("starter.accounts.groceries");
      expect(names(plan, "expenses")).toContain("starter.accounts.other");
    }
  });

  it("planTree nests children under parents in plan order", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "solo");
    a = applyOption(a, "transport", "car");
    const tree = planTree(planStarterBook(a, "ILS"));
    expect(tree.map((n) => n.key)).toEqual(["assets", "liabilities", "income", "expenses"]);
    const car = tree[3].children.find((n) => n.key === "car")!;
    expect(car.children.map((n) => n.key)).toEqual(["fuel", "carInsurance", "carRepairs", "parking"]);
  });

  /** Tap every option a "many" question currently offers that isn't already selected. Deriving
   * the taps from the live question definitions (rather than writing the union's current
   * members out as literals) means a future addition to `IncomeSource`, `Transport`,
   * `MoneyPlace` or `Extra` gets exercised automatically by this test, instead of silently
   * missing coverage the way a hardcoded list would. */
  function tapAllOptions(a: Answers, id: QuestionId): Answers {
    let next = a;
    const q = QUESTIONS.find((x) => x.id === id)!;
    for (const option of q.options(next, "ILS")) {
      if (!selectedOptions(next, id).includes(option)) next = applyOption(next, id, option);
    }
    return next;
  }

  it("the maximal plan (every group and every extra at once) has unique keys and resolvable parents", () => {
    // "one" questions stay literal: the maximal plan depends on choosing one specific answer
    // for each, not "all of them" (there is no "all of them" for a single choice) — "family" is
    // the household that unlocks the children group, "mortgage" is the housing that yields both
    // the liabilities line and the housing-group interest line, "3" is the card count that
    // yields the most numbered cards, and each yes/no follow-up must be "yes" to add its branch.
    // "many" questions (income, transport, money, extras) are derived via `tapAllOptions` below
    // instead, because their unions could grow and a hardcoded list of "every current member"
    // would not tap a future new member.
    let a = applyOption(EMPTY_ANSWERS, "household", "family");
    a = applyOption(a, "childAges", "under3");
    a = applyOption(a, "childAges", "school");
    a = applyOption(a, "childAges", "student");
    a = tapAllOptions(a, "income");
    a = applyOption(a, "trackBusiness", "yes");
    a = applyOption(a, "housing", "mortgage");
    a = applyOption(a, "buildingFees", "yes");
    a = tapAllOptions(a, "transport");
    a = applyOption(a, "carLoan", "yes");
    a = tapAllOptions(a, "money");
    a = applyOption(a, "secondBank", "yes");
    a = applyOption(a, "cardCount", "3");
    a = applyOption(a, "fxCurrency", "USD");
    a = tapAllOptions(a, "extras");

    const plan = planStarterBook(a, "ILS");
    const keys = new Set(plan.map((p) => p.key));
    const duplicate = plan.map((p) => p.key).find((k, i) => plan.findIndex((p) => p.key === k) !== i);
    expect(keys.size, `expected all ${plan.length} keys unique, duplicate: ${duplicate}`).toBe(plan.length);
    for (const item of plan) {
      if (item.parentKey !== null) expect(keys.has(item.parentKey), `${item.key}'s parent ${item.parentKey} is missing`).toBe(true);
    }
    for (const groupKey of ["housing", "car", "children", "business"]) {
      expect(keys.has(groupKey), `expected group "${groupKey}" in the maximal plan`).toBe(true);
    }
    expect(plan.length).toBeGreaterThanOrEqual(52);
  });
});
