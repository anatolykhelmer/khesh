import { describe, expect, it } from "vitest";
import type { CurrencyCode } from "../../src/kernel";
import { CURRENCIES } from "../../src/app/currencies";
import {
  applyHomeCurrency,
  applyOption,
  EMPTY_ANSWERS,
  nextStep,
  previousStep,
  QUESTIONS,
  selectedOptions,
  visibleSteps,
  type Answers,
} from "../../src/app/onboarding/questionnaire";

/**
 * A bounded, representative sample of reachable Answers — not every reachable Answers.
 * The three properties this drives (every question reachable, no dead option, next/
 * previous are inverses) are each about one question in isolation against whatever else
 * is already answered; none of them needs the cartesian product of every "many"
 * question's subsets, which is what a full walk of every path produces (217k states for
 * this tree). So for each of the four household answers, and independently for each
 * question, we apply none/one/all of that question's options on top of the household
 * base only — never on top of another question's partial answer — which keeps the count
 * linear in the number of questions and options instead of exponential in them.
 */
const HOUSEHOLDS = ["solo", "couple", "family", "skip"] as const;

function householdBase(h: (typeof HOUSEHOLDS)[number], home: CurrencyCode): Answers {
  return applyOption(EMPTY_ANSWERS, "household", h, home);
}

function addUnique(states: Answers[], seen: Set<string>, a: Answers): void {
  const key = JSON.stringify(a);
  if (seen.has(key)) return;
  seen.add(key);
  states.push(a);
}

function representativeStates(home: CurrencyCode = "ILS"): Answers[] {
  const states: Answers[] = [];
  const seen = new Set<string>();

  for (const h of HOUSEHOLDS) {
    const base = householdBase(h, home);
    addUnique(states, seen, base); // none of any question's options applied
    for (const q of QUESTIONS) {
      const options = q.options(base, home);
      for (const option of options) {
        addUnique(states, seen, applyOption(base, q.id, option, home)); // one option alone
      }
      let allApplied = base;
      for (const option of options) allApplied = applyOption(allApplied, q.id, option, home);
      addUnique(states, seen, allApplied); // every option of this question
    }
  }

  // Hand-built states that chain a follow-up onto its trigger, so questions gated on a
  // second answer (not just the household) are exercised too.
  const solo = householdBase("solo", home);
  const family = householdBase("family", home);
  const deep: Answers[] = [
    ...(["under3", "school", "student"] as const).map((age) => applyOption(family, "childAges", age, home)),
    ...(["yes", "no"] as const).map((yn) =>
      applyOption(applyOption(solo, "income", "freelance", home), "trackBusiness", yn, home),
    ),
    ...(["yes", "no"] as const).map((yn) =>
      applyOption(applyOption(solo, "transport", "car", home), "carLoan", yn, home),
    ),
    ...(["yes", "no"] as const).map((yn) =>
      applyOption(applyOption(solo, "money", "bank", home), "secondBank", yn, home),
    ),
    ...(["1", "2", "3"] as const).map((count) =>
      applyOption(applyOption(solo, "money", "card", home), "cardCount", count, home),
    ),
    ...CURRENCIES.filter((c) => c !== home).map((currency) =>
      applyOption(applyOption(solo, "money", "fx", home), "fxCurrency", currency, home),
    ),
    ...(["rent", "mortgage", "own", "family"] as const).flatMap((housing) =>
      (["yes", "no"] as const).map((yn) => applyOption(applyOption(solo, "housing", housing, home), "buildingFees", yn, home)),
    ),
  ];
  for (const a of deep) addUnique(states, seen, a);

  return states;
}

/**
 * Every representative state built under a *different* home currency, re-settled against
 * this one. The home currency is an input to the tree that is not an answer in it — the
 * other-currency question offers every currency but this one — and it stays editable after
 * the answers are given, so this is the shape of state the wizard reaches when the user
 * jumps back to the first step and changes the book's currency.
 */
function currencySwitchedStates(home: CurrencyCode): Answers[] {
  return CURRENCIES.filter((c) => c !== home).flatMap((other) =>
    representativeStates(other).map((a) => applyHomeCurrency(a, home)),
  );
}

describe("questionnaire", () => {
  it("the representative-state list stays small", () => {
    const states = representativeStates();
    expect(states.length).toBeGreaterThan(0);
    expect(states.length).toBeLessThan(1000);
  });

  it("starts at setup, ends at summary, and every question sits between them", () => {
    const steps = visibleSteps(EMPTY_ANSWERS);
    expect(steps[0]).toBe("setup");
    expect(steps[steps.length - 1]).toBe("summary");
    // Nothing answered: only the root question is visible.
    expect(steps).toEqual(["setup", "household", "summary"]);
  });

  it("skip jumps straight from household to summary", () => {
    const a = applyOption(EMPTY_ANSWERS, "household", "skip", "ILS");
    expect(nextStep("household", a)).toBe("summary");
    expect(visibleSteps(a)).toEqual(["setup", "household", "summary"]);
  });

  it("every question is reachable on some path", () => {
    const reached = new Set<string>();
    for (const a of representativeStates()) for (const s of visibleSteps(a)) reached.add(s);
    for (const q of QUESTIONS) expect(reached.has(q.id), q.id).toBe(true);
  });

  it("no option is dead: tapping an unselected option changes the answers", () => {
    for (const a of representativeStates()) {
      for (const q of QUESTIONS) {
        if (!q.visibleWhen(a)) continue;
        for (const option of q.options(a, "ILS")) {
          if (selectedOptions(a, q.id).includes(option)) continue;
          expect(applyOption(a, q.id, option, "ILS"), `${q.id}/${option}`).not.toEqual(a);
        }
      }
    }
  });

  it("next and previous are inverses along every path", () => {
    for (const a of representativeStates()) {
      const steps = visibleSteps(a);
      for (let i = 0; i < steps.length - 1; i++) {
        expect(nextStep(steps[i], a)).toBe(steps[i + 1]);
        expect(previousStep(steps[i + 1], a)).toBe(steps[i]);
      }
      expect(previousStep("setup", a)).toBe("setup");
      expect(nextStep("summary", a)).toBe("summary");
    }
  });

  it("second salary is offered only to couples and families", () => {
    const solo = applyOption(EMPTY_ANSWERS, "household", "solo", "ILS");
    const couple = applyOption(EMPTY_ANSWERS, "household", "couple", "ILS");
    const q = QUESTIONS.find((x) => x.id === "income")!;
    expect(q.options(solo, "ILS")).not.toContain("salary2");
    expect(q.options(couple, "ILS")).toContain("salary2");
  });

  it("the other-currency question offers every currency but the home one", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "solo", "ILS");
    a = applyOption(a, "money", "fx", "ILS");
    const q = QUESTIONS.find((x) => x.id === "fxCurrency")!;
    expect(q.visibleWhen(a)).toBe(true);
    expect(q.options(a, "ILS")).toEqual(["USD", "EUR"]);
    expect(q.options(a, "USD")).toEqual(["ILS", "EUR"]);
  });

  it("choosing a household pre-checks that household's extras", () => {
    const solo = applyOption(EMPTY_ANSWERS, "household", "solo", "ILS");
    expect(selectedOptions(solo, "extras")).toEqual(["health", "phone", "leisure"]);
    const family = applyOption(EMPTY_ANSWERS, "household", "family", "ILS");
    expect(selectedOptions(family, "extras")).toEqual([
      "health", "phone", "leisure", "clothing", "travel", "gifts",
    ]);
  });

  it("a 'many' option toggles; a 'one' option replaces; yes/no and counts round-trip", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "solo", "ILS");
    a = applyOption(a, "money", "cash", "ILS");
    a = applyOption(a, "money", "card", "ILS");
    expect(selectedOptions(a, "money")).toEqual(["cash", "card"]);
    a = applyOption(a, "money", "cash", "ILS");
    expect(selectedOptions(a, "money")).toEqual(["card"]);
    a = applyOption(a, "cardCount", "2", "ILS");
    expect(a.cardCount).toBe(2);
    expect(selectedOptions(a, "cardCount")).toEqual(["2"]);
    a = applyOption(a, "housing", "rent", "ILS");
    a = applyOption(a, "buildingFees", "yes", "ILS");
    expect(a.buildingFees).toBe(true);
    a = applyOption(a, "buildingFees", "no", "ILS");
    expect(a.buildingFees).toBe(false);
    expect(selectedOptions(a, "buildingFees")).toEqual(["no"]);
  });

  it("dropping an answer hides its follow-up and clears it", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "solo", "ILS");
    a = applyOption(a, "transport", "car", "ILS");
    a = applyOption(a, "carLoan", "yes", "ILS");
    expect(visibleSteps(a)).toContain("carLoan");
    a = applyOption(a, "transport", "car", "ILS");
    expect(visibleSteps(a)).not.toContain("carLoan");
    expect(a.carLoan).toBeNull();
  });

  it("changing household away from a multi-earner household drops salary2 from income", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "couple", "ILS");
    a = applyOption(a, "income", "salary2", "ILS");
    expect(a.income).toContain("salary2");
    a = applyOption(a, "household", "solo", "ILS");
    expect(a.income).not.toContain("salary2");
  });

  it("changing an unrelated answer does not clear an already-answered yes/no follow-up", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "solo", "ILS");
    a = applyOption(a, "transport", "car", "ILS");
    a = applyOption(a, "carLoan", "yes", "ILS");
    expect(a.carLoan).toBe(true);
    a = applyOption(a, "extras", "sport", "ILS"); // unrelated: does not affect carLoan's visibility or options
    expect(a.carLoan).toBe(true);
    expect(selectedOptions(a, "carLoan")).toEqual(["yes"]);
  });

  it("every stored answer is a value its question currently allows", () => {
    // Beyond representativeStates(), specifically cover answering a question and then
    // changing the household afterwards, which is how a stored answer can fall outside
    // its own question's current options while the question stays visible (the reported
    // bug: household=couple, income=salary2, then household=solo).
    const householdSwitchedStates = (): Answers[] => {
      let a1 = applyOption(EMPTY_ANSWERS, "household", "couple", "ILS");
      a1 = applyOption(a1, "income", "salary2", "ILS");
      a1 = applyOption(a1, "household", "solo", "ILS");

      let a2 = applyOption(EMPTY_ANSWERS, "household", "family", "ILS");
      a2 = applyOption(a2, "childAges", "under3", "ILS");
      a2 = applyOption(a2, "household", "solo", "ILS");

      let a3 = applyOption(EMPTY_ANSWERS, "household", "solo", "ILS");
      a3 = applyOption(a3, "income", "freelance", "ILS");
      a3 = applyOption(a3, "trackBusiness", "yes", "ILS");
      a3 = applyOption(a3, "household", "couple", "ILS");

      let a4 = applyOption(EMPTY_ANSWERS, "household", "solo", "ILS");
      a4 = applyOption(a4, "transport", "car", "ILS");
      a4 = applyOption(a4, "carLoan", "yes", "ILS");
      a4 = applyOption(a4, "household", "family", "ILS");

      let a5 = applyOption(EMPTY_ANSWERS, "household", "solo", "ILS");
      a5 = applyOption(a5, "money", "bank", "ILS");
      a5 = applyOption(a5, "secondBank", "yes", "ILS");
      a5 = applyOption(a5, "household", "couple", "ILS");

      let a6 = applyOption(EMPTY_ANSWERS, "household", "solo", "ILS");
      a6 = applyOption(a6, "money", "card", "ILS");
      a6 = applyOption(a6, "cardCount", "2", "ILS");
      a6 = applyOption(a6, "household", "family", "ILS");

      let a7 = applyOption(EMPTY_ANSWERS, "household", "solo", "ILS");
      a7 = applyOption(a7, "money", "fx", "ILS");
      a7 = applyOption(a7, "fxCurrency", "USD", "ILS");
      a7 = applyOption(a7, "household", "couple", "ILS");

      return [a1, a2, a3, a4, a5, a6, a7];
    };

    for (const a of [...representativeStates(), ...householdSwitchedStates()]) {
      for (const q of QUESTIONS) {
        if (!q.visibleWhen(a)) continue;
        const offered = q.options(a, "ILS");
        for (const selected of selectedOptions(a, q.id)) {
          expect(offered, `${q.id}=${selected}`).toContain(selected);
        }
      }
    }
  });

  /**
   * The two invariants `applyOption` and `applyHomeCurrency` settle to, asserted directly
   * over every reachable state this file can build, under every home currency the app
   * offers. The planner reads answers as `a.cardCount !== null` / `a.fxCurrency !== null`
   * and the screen renders `selectedOptions` against `options()`: the first invariant is
   * what keeps the planner from dropping something the user ticked, the second what keeps
   * the screen from showing a question with nothing selected while Next stays enabled.
   * Neither is gated on how the user got there, which is the point — the bug both of these
   * replace was reachable only off the linear path, through a progress-bar jump.
   */
  it("every visible single-select question has an answer, under every home currency", () => {
    for (const home of CURRENCIES) {
      for (const a of [...representativeStates(home), ...currencySwitchedStates(home)]) {
        for (const q of QUESTIONS) {
          if (!q.visibleWhen(a) || q.kind !== "one") continue;
          expect(selectedOptions(a, q.id), `home ${home}: ${q.id} is visible and unanswered`)
            .toHaveLength(1);
        }
      }
    }
  });

  /**
   * The type makes every single-select question *carry* a default; only this can say the
   * default is a value the question would actually offer at the moment it is seeded. A
   * default that is not among the current options would be written in and pruned straight
   * back out, leaving the question visible and unanswered — finding 1 all over again, and
   * silently, since the loop that does it terminates either way.
   */
  it("every declared default is an option its question currently offers", () => {
    for (const home of CURRENCIES) {
      for (const a of [...representativeStates(home), ...currencySwitchedStates(home)]) {
        for (const q of QUESTIONS) {
          if (q.kind !== "one") continue;
          expect(q.options(a, home), `home ${home}: ${q.id}`).toContain(q.defaultOption(a, home));
        }
      }
    }
  });

  /** The defaults are a product decision, not an implementation detail: each one is the
   * answer that adds nothing to the plan beyond what the user already said. Ticking "own
   * car" must not assert a debt, and answering only the household must not assert rent. */
  it("no seeded default plans anything the user did not ask for", () => {
    const a = applyOption(EMPTY_ANSWERS, "household", "couple", "ILS");
    expect(a.housing).toBe("family"); // the one housing answer that plans no housing group
    expect(visibleSteps(a)).not.toContain("buildingFees"); // and so nothing cascades from it
    const withCar = applyOption(a, "transport", "car", "ILS");
    expect(withCar.carLoan).toBe(false);
    const withBank = applyOption(a, "money", "bank", "ILS");
    expect(withBank.secondBank).toBe(false);
    const freelancing = applyOption(a, "income", "freelance", "ILS");
    expect(freelancing.trackBusiness).toBe(false);
  });

  it("no stored answer is absent from its question's options, under every home currency", () => {
    for (const home of CURRENCIES) {
      for (const a of [...representativeStates(home), ...currencySwitchedStates(home)]) {
        for (const q of QUESTIONS) {
          if (!q.visibleWhen(a)) continue;
          const offered = q.options(a, home);
          for (const selected of selectedOptions(a, q.id)) {
            expect(offered, `home ${home}: ${q.id}=${selected}`).toContain(selected);
          }
        }
      }
    }
  });

  it("ticking a credit card answers the card count on the spot", () => {
    // The reported path: walk to the summary, tap "Accounts" in the progress bar, tick
    // "Credit card", then tap "Summary". `cardCount` is visible but was never walked
    // through, and the planner's `a.cardCount !== null` then created no card at all — a
    // user who said they have a credit card got none. Seeding makes the jump and the walk
    // agree, without either of them having to know about the other.
    let a = applyOption(EMPTY_ANSWERS, "household", "solo", "ILS");
    a = applyOption(a, "money", "card", "ILS");
    expect(visibleSteps(a)).toContain("cardCount");
    expect(a.cardCount).toBe(1);
    // The seed is the count the question declares as adding nothing beyond the tick — the
    // lowest one — and not whatever its option list happens to render first.
    const cardCount = QUESTIONS.find((q) => q.id === "cardCount")!;
    if (cardCount.kind !== "one") throw new Error("cardCount is a single-select question");
    expect(selectedOptions(a, "cardCount")).toEqual([cardCount.defaultOption(a, "ILS")]);
    // Unticking the card puts it back to unanswered, so nothing stale reaches the planner.
    expect(applyOption(a, "money", "card", "ILS").cardCount).toBeNull();
  });

  it("changing the home currency re-chooses a foreign-currency account that would collide", () => {
    // The other reported path: choose a USD account, then jump back to the first step and
    // make the book itself USD. The answer must not survive as "a USD account in a USD
    // book" (the planner would emit one, and the summary hides the suffix that would show
    // it), and it must not be left null either, or the account the user asked for vanishes.
    let a = applyOption(EMPTY_ANSWERS, "household", "solo", "ILS");
    a = applyOption(a, "money", "fx", "ILS");
    a = applyOption(a, "fxCurrency", "USD", "ILS");
    expect(a.fxCurrency).toBe("USD");

    const switched = applyHomeCurrency(a, "USD");
    expect(switched.fxCurrency).not.toBe("USD");
    expect(switched.fxCurrency).not.toBeNull();
    const fx = QUESTIONS.find((q) => q.id === "fxCurrency")!;
    expect(fx.options(switched, "USD")).toContain(switched.fxCurrency);
    // A currency change that does not collide leaves the user's choice alone.
    expect(applyHomeCurrency(a, "EUR").fxCurrency).toBe("USD");
  });
});
