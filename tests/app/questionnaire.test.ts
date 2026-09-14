import { describe, expect, it } from "vitest";
import {
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

function householdBase(h: (typeof HOUSEHOLDS)[number]): Answers {
  return applyOption(EMPTY_ANSWERS, "household", h);
}

function addUnique(states: Answers[], seen: Set<string>, a: Answers): void {
  const key = JSON.stringify(a);
  if (seen.has(key)) return;
  seen.add(key);
  states.push(a);
}

function representativeStates(): Answers[] {
  const states: Answers[] = [];
  const seen = new Set<string>();

  for (const h of HOUSEHOLDS) {
    const base = householdBase(h);
    addUnique(states, seen, base); // none of any question's options applied
    for (const q of QUESTIONS) {
      const options = q.options(base, "ILS");
      for (const option of options) {
        addUnique(states, seen, applyOption(base, q.id, option)); // one option alone
      }
      let allApplied = base;
      for (const option of options) allApplied = applyOption(allApplied, q.id, option);
      addUnique(states, seen, allApplied); // every option of this question
    }
  }

  // Hand-built states that chain a follow-up onto its trigger, so questions gated on a
  // second answer (not just the household) are exercised too.
  const solo = householdBase("solo");
  const family = householdBase("family");
  const deep: Answers[] = [
    ...(["under3", "school", "student"] as const).map((age) => applyOption(family, "childAges", age)),
    ...(["yes", "no"] as const).map((yn) =>
      applyOption(applyOption(solo, "income", "freelance"), "trackBusiness", yn),
    ),
    ...(["yes", "no"] as const).map((yn) =>
      applyOption(applyOption(solo, "transport", "car"), "carLoan", yn),
    ),
    ...(["yes", "no"] as const).map((yn) =>
      applyOption(applyOption(solo, "money", "bank"), "secondBank", yn),
    ),
    ...(["1", "2", "3"] as const).map((count) =>
      applyOption(applyOption(solo, "money", "card"), "cardCount", count),
    ),
    ...(["USD", "EUR"] as const).map((currency) =>
      applyOption(applyOption(solo, "money", "fx"), "fxCurrency", currency),
    ),
    ...(["rent", "mortgage", "own", "family"] as const).flatMap((housing) =>
      (["yes", "no"] as const).map((yn) => applyOption(applyOption(solo, "housing", housing), "buildingFees", yn)),
    ),
  ];
  for (const a of deep) addUnique(states, seen, a);

  return states;
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
    const a = applyOption(EMPTY_ANSWERS, "household", "skip");
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
          expect(applyOption(a, q.id, option), `${q.id}/${option}`).not.toEqual(a);
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
    const solo = applyOption(EMPTY_ANSWERS, "household", "solo");
    const couple = applyOption(EMPTY_ANSWERS, "household", "couple");
    const q = QUESTIONS.find((x) => x.id === "income")!;
    expect(q.options(solo, "ILS")).not.toContain("salary2");
    expect(q.options(couple, "ILS")).toContain("salary2");
  });

  it("the other-currency question offers every currency but the home one", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "solo");
    a = applyOption(a, "money", "fx");
    const q = QUESTIONS.find((x) => x.id === "fxCurrency")!;
    expect(q.visibleWhen(a)).toBe(true);
    expect(q.options(a, "ILS")).toEqual(["USD", "EUR"]);
    expect(q.options(a, "USD")).toEqual(["ILS", "EUR"]);
  });

  it("choosing a household pre-checks that household's extras", () => {
    const solo = applyOption(EMPTY_ANSWERS, "household", "solo");
    expect(selectedOptions(solo, "extras")).toEqual(["health", "phone", "leisure"]);
    const family = applyOption(EMPTY_ANSWERS, "household", "family");
    expect(selectedOptions(family, "extras")).toEqual([
      "health", "phone", "leisure", "clothing", "travel", "gifts",
    ]);
  });

  it("a 'many' option toggles; a 'one' option replaces; yes/no and counts round-trip", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "solo");
    a = applyOption(a, "money", "cash");
    a = applyOption(a, "money", "card");
    expect(selectedOptions(a, "money")).toEqual(["cash", "card"]);
    a = applyOption(a, "money", "cash");
    expect(selectedOptions(a, "money")).toEqual(["card"]);
    a = applyOption(a, "cardCount", "2");
    expect(a.cardCount).toBe(2);
    expect(selectedOptions(a, "cardCount")).toEqual(["2"]);
    a = applyOption(a, "housing", "rent");
    a = applyOption(a, "buildingFees", "yes");
    expect(a.buildingFees).toBe(true);
    a = applyOption(a, "buildingFees", "no");
    expect(a.buildingFees).toBe(false);
    expect(selectedOptions(a, "buildingFees")).toEqual(["no"]);
  });

  it("dropping an answer hides its follow-up and clears it", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "solo");
    a = applyOption(a, "transport", "car");
    a = applyOption(a, "carLoan", "yes");
    expect(visibleSteps(a)).toContain("carLoan");
    a = applyOption(a, "transport", "car");
    expect(visibleSteps(a)).not.toContain("carLoan");
    expect(a.carLoan).toBeNull();
  });

  it("changing household away from a multi-earner household drops salary2 from income", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "couple");
    a = applyOption(a, "income", "salary2");
    expect(a.income).toContain("salary2");
    a = applyOption(a, "household", "solo");
    expect(a.income).not.toContain("salary2");
  });

  it("changing an unrelated answer does not clear an already-answered yes/no follow-up", () => {
    let a = applyOption(EMPTY_ANSWERS, "household", "solo");
    a = applyOption(a, "transport", "car");
    a = applyOption(a, "carLoan", "yes");
    expect(a.carLoan).toBe(true);
    a = applyOption(a, "extras", "sport"); // unrelated: does not affect carLoan's visibility or options
    expect(a.carLoan).toBe(true);
    expect(selectedOptions(a, "carLoan")).toEqual(["yes"]);
  });

  it("every stored answer is a value its question currently allows", () => {
    // Beyond representativeStates(), specifically cover answering a question and then
    // changing the household afterwards, which is how a stored answer can fall outside
    // its own question's current options while the question stays visible (the reported
    // bug: household=couple, income=salary2, then household=solo).
    const householdSwitchedStates = (): Answers[] => {
      let a1 = applyOption(EMPTY_ANSWERS, "household", "couple");
      a1 = applyOption(a1, "income", "salary2");
      a1 = applyOption(a1, "household", "solo");

      let a2 = applyOption(EMPTY_ANSWERS, "household", "family");
      a2 = applyOption(a2, "childAges", "under3");
      a2 = applyOption(a2, "household", "solo");

      let a3 = applyOption(EMPTY_ANSWERS, "household", "solo");
      a3 = applyOption(a3, "income", "freelance");
      a3 = applyOption(a3, "trackBusiness", "yes");
      a3 = applyOption(a3, "household", "couple");

      let a4 = applyOption(EMPTY_ANSWERS, "household", "solo");
      a4 = applyOption(a4, "transport", "car");
      a4 = applyOption(a4, "carLoan", "yes");
      a4 = applyOption(a4, "household", "family");

      let a5 = applyOption(EMPTY_ANSWERS, "household", "solo");
      a5 = applyOption(a5, "money", "bank");
      a5 = applyOption(a5, "secondBank", "yes");
      a5 = applyOption(a5, "household", "couple");

      let a6 = applyOption(EMPTY_ANSWERS, "household", "solo");
      a6 = applyOption(a6, "money", "card");
      a6 = applyOption(a6, "cardCount", "2");
      a6 = applyOption(a6, "household", "family");

      let a7 = applyOption(EMPTY_ANSWERS, "household", "solo");
      a7 = applyOption(a7, "money", "fx");
      a7 = applyOption(a7, "fxCurrency", "USD");
      a7 = applyOption(a7, "household", "couple");

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
});
