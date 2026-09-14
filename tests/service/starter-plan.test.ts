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
 * could actually produce (hidden follow-ups cleared, salary2 only when offered). Built
 * against the same home currency the plan is then made in: the home currency is an input
 * to the question tree, and answers settled against a different one are not a state the
 * wizard can be in. */
function arbAnswersFor(home: string): fc.Arbitrary<Answers> {
  return fc
    .array(fc.tuple(fc.nat(QUESTIONS.length - 1), fc.nat(9)), { maxLength: 40 })
    .map((taps) => {
      let a = EMPTY_ANSWERS;
      for (const [qi, oi] of taps) {
        const q = QUESTIONS[qi];
        if (!q.visibleWhen(a)) continue;
        const options = q.options(a, home);
        a = applyOption(a, q.id, options[oi % options.length], home);
      }
      return a;
    });
}

const arbHomeAndAnswers: fc.Arbitrary<[string, Answers]> = fc
  .constantFrom("ILS", "USD", "EUR")
  .chain((home) => fc.tuple(fc.constant(home), arbAnswersFor(home)));

describe("planStarterBook", () => {
  it("is the four roots when nothing is answered or the household is skipped", () => {
    expect(planStarterBook(EMPTY_ANSWERS, "ILS")).toEqual(rootsPlan("ILS"));
    expect(planStarterBook(applyOption(EMPTY_ANSWERS, "household", "skip", "ILS"), "ILS")).toEqual(rootsPlan("ILS"));
    const book = realize(rootsPlan("EUR"), "EUR");
    expect(book.accounts).toHaveLength(4);
    expect(book.accounts.every((a) => a.isPlaceholder && a.currency === "EUR")).toBe(true);
  });

  it("always realizes into a valid book with unique siblings and parents first", () => {
    fc.assert(
      fc.property(arbHomeAndAnswers, ([home, a]) => {
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
        // "Another currency" means another one: an account whose currency is the book's
        // own would render with its suffix suppressed and be indistinguishable from the
        // home-currency accounts around it.
        const fx = plan.find((p) => p.key === "fx");
        if (fx !== undefined) expect(fx.currency).not.toBe(home);
      }),
      { numRuns: 300 },
    );
  });

  /** The whole point of the wizard: what the user ticked becomes an account. A ticked
   * option whose follow-up was never walked through (a progress-bar jump straight to the
   * summary) used to plan nothing at all, because the planner reads the follow-up's
   * answer and the follow-up had none. */
  it("ticking a money place plans its accounts without visiting the follow-up", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "solo", "ILS");
    a = applyOption(a, "money", "card", "ILS");
    a = applyOption(a, "money", "fx", "ILS");
    const plan = planStarterBook(a, "ILS");
    expect(names(plan, "liabilities")).toContain("starter.accounts.creditCard");
    const fx = plan.find((p) => p.key === "fx");
    expect(fx, "a foreign-currency account was ticked but not planned").toBeDefined();
    expect(fx!.currency).not.toBe("ILS");
  });

  function names(plan: StarterAccount[], parentKey: string | null): string[] {
    return plan.filter((p) => p.parentKey === parentKey).map((p) => p.nameKey);
  }

  it("a family with school-age children gets a Children group with School and Activities", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "family", "ILS");
    a = applyOption(a, "childAges", "school", "ILS");
    const plan = planStarterBook(a, "ILS");
    expect(names(plan, "children")).toEqual([
      "starter.accounts.school",
      "starter.accounts.activities",
      "starter.accounts.childrenClothing",
    ]);
    expect(plan.find((p) => p.key === "children")).toMatchObject({ parentKey: "expenses", isPlaceholder: true, type: "expense" });
  });

  /* Choosing "a family with children" and then pressing Next past the ages question is the
   * user declining to say what those children cost. The group used to appear anyway, with
   * Clothing and toys under it, so the wizard answered a question the user had skipped. */
  it("a family that names no child ages gets no Children group at all", () => {
    const a = applyOption(EMPTY_ANSWERS, "household", "family", "ILS");
    expect(a.childAges).toEqual([]);
    const plan = planStarterBook(a, "ILS");
    expect(plan.find((p) => p.key === "children")).toBeUndefined();
    expect(plan.filter((p) => p.parentKey === "children")).toEqual([]);
    // And no orphan is left behind: the leaf that used to be unconditional is gone too.
    expect(plan.map((p) => p.key)).not.toContain("childrenClothing");
  });

  /* Unticking the last age is the same state arrived at from the other direction: the
   * group and every leaf under it have to go, not just the age-specific ones. */
  it("unticking the last child age removes the Children group again", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "family", "ILS");
    a = applyOption(a, "childAges", "student", "ILS");
    expect(planStarterBook(a, "ILS").find((p) => p.key === "children")).toBeDefined();
    a = applyOption(a, "childAges", "student", "ILS");
    expect(planStarterBook(a, "ILS").find((p) => p.key === "children")).toBeUndefined();
  });

  it("three credit cards are three numbered liabilities", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "solo", "ILS");
    a = applyOption(a, "money", "card", "ILS");
    a = applyOption(a, "cardCount", "3", "ILS");
    const cards = planStarterBook(a, "ILS").filter((p) => p.parentKey === "liabilities");
    expect(cards.map((p) => [p.nameKey, p.nameArgs])).toEqual([
      ["starter.accounts.creditCard", undefined],
      ["starter.accounts.creditCardN", { n: 2 }],
      ["starter.accounts.creditCardN", { n: 3 }],
    ]);
    expect(cards.every((p) => p.type === "liability" && !p.isPlaceholder)).toBe(true);
  });

  it("fuel appears once when both an own and a leased car are chosen", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "solo", "ILS");
    a = applyOption(a, "transport", "car", "ILS");
    a = applyOption(a, "transport", "lease", "ILS");
    const car = names(planStarterBook(a, "ILS"), "car");
    expect(car.filter((n) => n === "starter.accounts.fuel")).toHaveLength(1);
    expect(car).toContain("starter.accounts.lease");
  });

  it("mortgage is a liability plus an interest expense under Housing", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "couple", "ILS");
    a = applyOption(a, "housing", "mortgage", "ILS");
    const plan = planStarterBook(a, "ILS");
    expect(names(plan, "liabilities")).toContain("starter.accounts.mortgage");
    // "mortgage" reveals `buildingFees`, which is seeded with the answer that adds
    // nothing — "no" — so a user who chose a mortgage and walked on is not billed for
    // building fees they never mentioned.
    expect(names(plan, "housing")).toEqual([
      "starter.accounts.mortgageInterest",
      "starter.accounts.utilities",
      "starter.accounts.homeRepairs",
    ]);
  });

  it("living with family creates no housing group", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "solo", "ILS");
    a = applyOption(a, "housing", "family", "ILS");
    expect(planStarterBook(a, "ILS").some((p) => p.key === "housing")).toBe(false);
  });

  it("an account in another currency carries that currency", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "solo", "ILS");
    a = applyOption(a, "money", "fx", "ILS");
    a = applyOption(a, "fxCurrency", "USD", "ILS");
    const fx = planStarterBook(a, "ILS").find((p) => p.key === "fx")!;
    expect(fx).toMatchObject({ parentKey: "assets", currency: "USD", nameKey: "starter.accounts.fxAccount", nameArgs: { currency: "USD" } });
  });

  /** The tree a user sees if they answer the household question and jump straight to the
   * summary. Every line in it must be one the household answer itself accounts for:
   * seeding fills the follow-ups the household revealed, and a filled follow-up that
   * planned rent, a car loan or a second bank account would be the wizard inventing the
   * user's money for them. */
  it("answering only the household plans nothing the household did not say", () => {
    for (const h of ["solo", "couple", "family"] as const) {
      const plan = planStarterBook(applyOption(EMPTY_ANSWERS, "household", h, "ILS"), "ILS");
      const keys = plan.map((p) => p.key);
      for (const absent of ["housing", "rent", "buildingFees", "mortgage", "car", "carLoan", "bank", "bank2", "card", "fx"]) {
        expect(keys, `${h}: planned "${absent}" from the household answer alone`).not.toContain(absent);
      }
      expect(plan.filter((p) => p.parentKey === "liabilities")).toEqual([]);
      expect(plan.filter((p) => p.parentKey === "assets")).toEqual([]);
    }
  });

  it("groceries and other are always present for any real household", () => {
    for (const h of ["solo", "couple", "family"] as const) {
      const plan = planStarterBook(applyOption(EMPTY_ANSWERS, "household", h, "ILS"), "ILS");
      expect(names(plan, "expenses")).toContain("starter.accounts.groceries");
      expect(names(plan, "expenses")).toContain("starter.accounts.other");
    }
  });

  it("planTree nests children under parents in plan order", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "solo", "ILS");
    a = applyOption(a, "transport", "car", "ILS");
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
      if (!selectedOptions(next, id).includes(option)) next = applyOption(next, id, option, "ILS");
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
    let a = applyOption(EMPTY_ANSWERS, "household", "family", "ILS");
    a = applyOption(a, "childAges", "under3", "ILS");
    a = applyOption(a, "childAges", "school", "ILS");
    a = applyOption(a, "childAges", "student", "ILS");
    a = tapAllOptions(a, "income");
    a = applyOption(a, "trackBusiness", "yes", "ILS");
    a = applyOption(a, "housing", "mortgage", "ILS");
    a = applyOption(a, "buildingFees", "yes", "ILS");
    a = tapAllOptions(a, "transport");
    a = applyOption(a, "carLoan", "yes", "ILS");
    a = tapAllOptions(a, "money");
    a = applyOption(a, "secondBank", "yes", "ILS");
    a = applyOption(a, "cardCount", "3", "ILS");
    a = applyOption(a, "fxCurrency", "USD", "ILS");
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
