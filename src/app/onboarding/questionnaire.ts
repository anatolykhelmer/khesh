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
 * Apply one tap on one option. "many" questions toggle; "one" questions replace. The
 * result is settled (see `settle`), so a follow-up never carries a stale answer into the
 * plan (untick "own car" and `carLoan` goes back to null) and never stays unanswered
 * either (tick "credit card" and `cardCount` is already 1).
 *
 * `homeCurrency` is not an answer but it is an input to the tree: `fxCurrency` offers
 * every currency except that one. It is threaded in so that settling can both re-check a
 * stored `fxCurrency` against it and seed a fresh one from the options it really offers.
 */
export function applyOption(
  a: Answers,
  id: QuestionId,
  option: string,
  homeCurrency: CurrencyCode,
): Answers {
  return settle(setAnswer(a, id, option), homeCurrency);
}

/**
 * Re-settle answers that were settled against a different home currency. The home
 * currency is chosen on the wizard's first step but stays editable afterwards (jump back
 * to the Language section from the summary), so the screen calls this whenever it
 * changes: a stored `fxCurrency` that is now the home currency is dropped and re-seeded
 * from what `fxCurrency` offers under the new home, which is why "USD account in a USD
 * book" is not a state this module can hand to the planner.
 */
export function applyHomeCurrency(a: Answers, homeCurrency: CurrencyCode): Answers {
  return settle(a, homeCurrency);
}

/** One tap written into `Answers`, before settling. Seeding reuses it so that an option
 * id becomes a stored value in exactly one place, whoever chose the option. */
function setAnswer(a: Answers, id: QuestionId, option: string): Answers {
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
  return next;
}

/**
 * The option ids a question currently allows, or none at all once the question itself is
 * no longer visible. Folding "hidden" into "offers nothing" lets one rule cover both ways
 * an answer can go stale: a follow-up whose question disappeared, and an answer whose
 * question is still visible but no longer offers that particular value (income's
 * `"salary2"` once `household` moves away from a multi-earner household, for example).
 */
function currentlyAllowed(q: Question, a: Answers, homeCurrency: CurrencyCode): ReadonlySet<string> {
  if (!q.visibleWhen(a)) return new Set();
  return new Set(q.options(a, homeCurrency));
}

/**
 * A question already visible with nothing answered is one the wizard opens on: only the
 * user can answer it, and seeding it would put a household (and a whole plan behind it)
 * on screen before the first tap. Every other question became visible *because of* an
 * answer, which is what makes seeding it honest — the user turned on the option that
 * revealed it. Derived from the tree rather than a list of ids, so a question that stops
 * being conditional stops being seeded without anyone remembering to say so.
 */
function isFollowUp(q: Question): boolean {
  return !q.visibleWhen(EMPTY_ANSWERS);
}

/**
 * Restore two invariants over the whole answer set at once, because each can break the
 * other and neither is stable on its own.
 *
 * Pruning: every answer stored in `Answers` is either empty or a value its owning question
 * currently allows. An array answer keeps only the entries still allowed; a scalar answer
 * (a "one" question, a count, a currency, or a yes/no stored as a boolean) is cleared the
 * moment its one stored value falls outside the question's current options. A yes/no
 * answer is compared through the same boolean<->"yes"/"no" mapping `selectedOptions` uses,
 * never the boolean against the option string directly, so an answered follow-up is never
 * mistaken for an unanswered one.
 *
 * Seeding: every visible single-select follow-up has an answer — its question's own first
 * offered option, taken from `options()` so the seed cannot drift from the list the screen
 * renders. This is the invariant the planner relies on: it reads `a.cardCount !== null`
 * and `a.fxCurrency !== null`, and a visible question with no answer is exactly how a
 * ticked "credit card" used to create nothing when the user jumped past its follow-up
 * instead of walking through it. Holding it here rather than gating navigation means it
 * holds for *every* route through the wizard, including ones the screen has yet to invent.
 *
 * Runs to a fixpoint rather than one sweep over `QUESTIONS`, so nothing here depends on
 * prerequisites being listed before their dependents: pruning one answer can change what a
 * later question allows (clearing `income` down to no "freelance" hides `trackBusiness`
 * too) and seeding one can reveal the next (`housing` seeds "rent", which reveals
 * `buildingFees`), and the loop keeps going until a full pass changes nothing. It
 * terminates because the only answer whose value narrows another question's options is
 * `household`, and `household` is never seeded.
 */
function settle(a: Answers, homeCurrency: CurrencyCode): Answers {
  let out = a;
  for (let changed = true; changed; ) {
    changed = false;
    for (const q of QUESTIONS) {
      const allowed = currentlyAllowed(q, out, homeCurrency);
      const stored = out[q.id];
      if (Array.isArray(stored)) {
        const kept = (stored as string[]).filter((v) => allowed.has(v));
        if (kept.length !== stored.length) {
          out = { ...out, [q.id]: kept } as Answers;
          changed = true;
        }
        continue;
      }
      if (stored !== null) {
        const asOption = typeof stored === "boolean" ? (stored ? "yes" : "no") : String(stored);
        if (!allowed.has(asOption)) {
          out = { ...out, [q.id]: null } as Answers;
          changed = true;
        }
        continue;
      }
      if (q.kind !== "one" || !isFollowUp(q)) continue;
      const [first] = q.options(out, homeCurrency);
      if (allowed.size > 0 && first !== undefined) {
        out = setAnswer(out, q.id, first);
        changed = true;
      }
    }
  }
  return out;
}
