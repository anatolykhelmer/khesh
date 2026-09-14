import type { CurrencyCode } from "../../kernel";
import { CURRENCIES } from "../currencies";

/**
 * The onboarding question tree as data. No React and no i18n: the screen asks this
 * module which step comes next and which options a question offers, and renders what it
 * is told. Keeping the branching here is what lets `tests/app/questionnaire.test.ts`
 * walk every path in a repo whose Vitest cannot mount a component.
 *
 * Option ids double as i18n key tails: option `"rent"` of question `"housing"` is shown
 * as `t("onboarding.wizard.q.housing.rent")`.
 */

export type Household = "solo" | "couple" | "family" | "skip";
export type ChildAge = "under3" | "school" | "student";
export type IncomeSource = "salary" | "salary2" | "freelance" | "benefits" | "rental" | "investments";
export type Housing = "rent" | "mortgage" | "own" | "family";
export type Transport = "car" | "lease" | "public" | "walk";
export type MoneyPlace = "cash" | "bank" | "card" | "savings" | "fx";
export type Extra =
  | "health" | "clothing" | "leisure" | "phone" | "gifts"
  | "travel" | "sport" | "beauty" | "pets" | "education";
export type CardCount = 1 | 2 | 3;

export type Answers = {
  household: Household | null;
  childAges: ChildAge[];
  income: IncomeSource[];
  trackBusiness: boolean | null;
  housing: Housing | null;
  buildingFees: boolean | null;
  transport: Transport[];
  carLoan: boolean | null;
  money: MoneyPlace[];
  secondBank: boolean | null;
  cardCount: CardCount | null;
  fxCurrency: CurrencyCode | null;
  extras: Extra[];
};

export const EMPTY_ANSWERS: Answers = {
  household: null,
  childAges: [],
  income: [],
  trackBusiness: null,
  housing: null,
  buildingFees: null,
  transport: [],
  carLoan: null,
  money: [],
  secondBank: null,
  cardCount: null,
  fxCurrency: null,
  extras: [],
};

export type QuestionId = keyof Answers;
export type SectionId =
  | "setup" | "household" | "income" | "home" | "transport" | "accounts" | "extras" | "summary";
export type Step = "setup" | QuestionId | "summary";

export const SECTIONS: readonly SectionId[] = [
  "setup", "household", "income", "home", "transport", "accounts", "extras", "summary",
];

export type Question = {
  id: QuestionId;
  section: SectionId;
  kind: "one" | "many";
  visibleWhen: (a: Answers) => boolean;
  options: (a: Answers, homeCurrency: CurrencyCode) => readonly string[];
};

const answered = (a: Answers): boolean => a.household !== null && a.household !== "skip";
const YES_NO = ["yes", "no"] as const;
const ALL_EXTRAS: readonly Extra[] = [
  "health", "clothing", "leisure", "phone", "gifts", "travel", "sport", "beauty", "pets", "education",
];

export const QUESTIONS: readonly Question[] = [
  {
    id: "household", section: "household", kind: "one",
    visibleWhen: () => true,
    options: () => ["solo", "couple", "family", "skip"],
  },
  {
    id: "childAges", section: "household", kind: "many",
    visibleWhen: (a) => a.household === "family",
    options: () => ["under3", "school", "student"],
  },
  {
    id: "income", section: "income", kind: "many",
    visibleWhen: answered,
    options: (a) =>
      a.household === "solo"
        ? ["salary", "freelance", "benefits", "rental", "investments"]
        : ["salary", "salary2", "freelance", "benefits", "rental", "investments"],
  },
  {
    id: "trackBusiness", section: "income", kind: "one",
    visibleWhen: (a) => answered(a) && a.income.includes("freelance"),
    options: () => YES_NO,
  },
  {
    id: "housing", section: "home", kind: "one",
    visibleWhen: answered,
    options: () => ["rent", "mortgage", "own", "family"],
  },
  {
    id: "buildingFees", section: "home", kind: "one",
    visibleWhen: (a) => answered(a) && a.housing !== null && a.housing !== "family",
    options: () => YES_NO,
  },
  {
    id: "transport", section: "transport", kind: "many",
    visibleWhen: answered,
    options: () => ["car", "lease", "public", "walk"],
  },
  {
    id: "carLoan", section: "transport", kind: "one",
    visibleWhen: (a) => answered(a) && a.transport.includes("car"),
    options: () => YES_NO,
  },
  {
    id: "money", section: "accounts", kind: "many",
    visibleWhen: answered,
    options: () => ["cash", "bank", "card", "savings", "fx"],
  },
  {
    id: "secondBank", section: "accounts", kind: "one",
    visibleWhen: (a) => answered(a) && a.money.includes("bank"),
    options: () => YES_NO,
  },
  {
    id: "cardCount", section: "accounts", kind: "one",
    visibleWhen: (a) => answered(a) && a.money.includes("card"),
    options: () => ["1", "2", "3"],
  },
  {
    id: "fxCurrency", section: "accounts", kind: "one",
    visibleWhen: (a) => answered(a) && a.money.includes("fx"),
    options: (_a, home) => CURRENCIES.filter((c) => c !== home),
  },
  {
    id: "extras", section: "extras", kind: "many",
    visibleWhen: answered,
    options: () => ALL_EXTRAS,
  },
];

export function defaultExtras(household: Household): Extra[] {
  switch (household) {
    case "solo": return ["health", "phone", "leisure"];
    case "couple": return ["health", "phone", "leisure", "clothing", "travel"];
    case "family": return ["health", "phone", "leisure", "clothing", "travel", "gifts"];
    case "skip": return [];
  }
}

export function visibleSteps(a: Answers): Step[] {
  return ["setup", ...QUESTIONS.filter((q) => q.visibleWhen(a)).map((q) => q.id), "summary"];
}

export function nextStep(current: Step, a: Answers): Step {
  const steps = visibleSteps(a);
  const i = steps.indexOf(current);
  return steps[Math.min(i + 1, steps.length - 1)];
}

export function previousStep(current: Step, a: Answers): Step {
  const steps = visibleSteps(a);
  const i = steps.indexOf(current);
  return steps[Math.max(i - 1, 0)];
}

export function sectionOf(step: Step): SectionId {
  if (step === "setup" || step === "summary") return step;
  return QUESTIONS.find((q) => q.id === step)!.section;
}

/** The option ids currently selected for a question, in a form the screen can render. */
export function selectedOptions(a: Answers, id: QuestionId): readonly string[] {
  const value = a[id];
  if (value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "boolean") return [value ? "yes" : "no"];
  return [String(value)];
}

function toggle<T extends string>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/**
 * Apply one tap on one option. "many" questions toggle; "one" questions replace. Answers
 * to questions that are no longer visible afterwards are cleared, so a follow-up never
 * carries a stale answer into the plan (untick "own car" and `carLoan` goes back to null).
 */
export function applyOption(a: Answers, id: QuestionId, option: string): Answers {
  let next: Answers;
  switch (id) {
    case "household": {
      const household = option as Household;
      next = { ...a, household, extras: defaultExtras(household) };
      break;
    }
    case "childAges": next = { ...a, childAges: toggle(a.childAges, option as ChildAge) }; break;
    case "income": next = { ...a, income: toggle(a.income, option as IncomeSource) }; break;
    case "trackBusiness": next = { ...a, trackBusiness: option === "yes" }; break;
    case "housing": next = { ...a, housing: option as Housing }; break;
    case "buildingFees": next = { ...a, buildingFees: option === "yes" }; break;
    case "transport": next = { ...a, transport: toggle(a.transport, option as Transport) }; break;
    case "carLoan": next = { ...a, carLoan: option === "yes" }; break;
    case "money": next = { ...a, money: toggle(a.money, option as MoneyPlace) }; break;
    case "secondBank": next = { ...a, secondBank: option === "yes" }; break;
    case "cardCount": next = { ...a, cardCount: Number(option) as CardCount }; break;
    case "fxCurrency": next = { ...a, fxCurrency: option }; break;
    case "extras": next = { ...a, extras: toggle(a.extras, option as Extra) }; break;
  }
  return pruneAnswers(next);
}

/**
 * Home currency is never part of `Answers` and `applyOption` is never given one, so this
 * pass can't re-check a stored `fxCurrency` against the real home. Only `fxCurrency`'s own
 * `options()` looks at its `homeCurrency` argument at all, and it only ever *excludes* that
 * one currency from `CURRENCIES` — passing a value that is never a real currency code makes
 * that exclusion a no-op, so pruning can't contradict a choice it has no way to re-check.
 */
const NOT_A_REAL_CURRENCY: CurrencyCode = "";

/**
 * The option ids a question currently allows, or none at all once the question itself is
 * no longer visible. Folding "hidden" into "offers nothing" lets one rule cover both ways
 * an answer can go stale: a follow-up whose question disappeared, and an answer whose
 * question is still visible but no longer offers that particular value (income's
 * `"salary2"` once `household` moves away from a multi-earner household, for example).
 */
function currentlyAllowed(q: Question, a: Answers): ReadonlySet<string> {
  if (!q.visibleWhen(a)) return new Set();
  return new Set(q.options(a, NOT_A_REAL_CURRENCY));
}

/**
 * Restore the invariant that every answer stored in `Answers` is either empty or a value
 * its owning question currently allows. An array answer keeps only the entries still
 * allowed; a scalar answer (a "one" question, a count, a currency, or a yes/no stored as a
 * boolean) is cleared the moment its one stored value falls outside the question's current
 * options. A yes/no answer is compared through the same boolean<->"yes"/"no" mapping
 * `selectedOptions` uses, never the boolean against the option string directly, so an
 * answered follow-up is never mistaken for an unanswered one.
 *
 * Runs to a fixpoint rather than one sweep over `QUESTIONS`, so nothing here depends on
 * prerequisites being listed before their dependents: pruning one answer can change what a
 * later question allows (clearing `income` down to no "freelance" hides `trackBusiness`
 * too), and the loop keeps going until a full pass changes nothing.
 */
function pruneAnswers(a: Answers): Answers {
  let out = a;
  for (let changed = true; changed; ) {
    changed = false;
    for (const q of QUESTIONS) {
      const allowed = currentlyAllowed(q, out);
      const stored = out[q.id];
      if (Array.isArray(stored)) {
        const kept = (stored as string[]).filter((v) => allowed.has(v));
        if (kept.length !== stored.length) {
          out = { ...out, [q.id]: kept } as Answers;
          changed = true;
        }
        continue;
      }
      if (stored === null) continue;
      const asOption = typeof stored === "boolean" ? (stored ? "yes" : "no") : String(stored);
      if (!allowed.has(asOption)) {
        out = { ...out, [q.id]: null } as Answers;
        changed = true;
      }
    }
  }
  return out;
}
