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

type QuestionBase = {
  id: QuestionId;
  section: SectionId;
  visibleWhen: (a: Answers) => boolean;
  options: (a: Answers, homeCurrency: CurrencyCode) => readonly string[];
};

/**
 * A "many" question may be left empty — nothing chosen is a valid answer ("no car, no
 * lease, no public transport") — so it needs no default. A "one" question must carry one,
 * because `settle` answers it the moment it becomes visible and the planner reads that
 * answer. Splitting the two kinds into a union is what makes the default a *compile-time*
 * requirement: a new single-select question written without `defaultOption` does not
 * typecheck, the same way a forgotten `Extra` does not.
 *
 * `defaultOption` is a function of the answers and the home currency, not a constant,
 * because `fxCurrency`'s neutral answer is "whichever currency this book is not in".
 *
 * What a default must be is a *semantic* decision, never "whatever `options` lists first":
 * render order is a UI concern and would silently become a claim about the user's money.
 * The rule is that a seeded answer adds nothing beyond what the user has already said —
 * "no" to every yes/no follow-up, the lowest credit-card count (ticking "credit card" does
 * assert one card), and for `housing` the one option that creates no housing group.
 */
export type Question =
  | (QuestionBase & { kind: "many" })
  | (QuestionBase & {
      kind: "one";
      defaultOption: (a: Answers, homeCurrency: CurrencyCode) => string;
    });

const answered = (a: Answers): boolean => a.household !== null && a.household !== "skip";
const YES_NO = ["yes", "no"] as const;
/**
 * Every member of `Extra`, in the order the question offers them. Written as a record
 * keyed by the union rather than as an array of it, so a member added to `Extra` and
 * forgotten here is a compile error ("property is missing") instead of an extra that
 * silently stops being offered — which nothing else would catch, since a smaller list is
 * still a valid `readonly Extra[]`. Key order is offer order: these are all non-numeric
 * keys, so `Object.keys` returns them exactly as written.
 */
const EXTRA_OFFER_ORDER: Record<Extra, true> = {
  health: true, clothing: true, leisure: true, phone: true, gifts: true,
  travel: true, sport: true, beauty: true, pets: true, education: true,
};
const ALL_EXTRAS = Object.keys(EXTRA_OFFER_ORDER) as readonly Extra[];

export const QUESTIONS: readonly Question[] = [
  {
    id: "household", section: "household", kind: "one",
    visibleWhen: () => true,
    // Never actually applied: this is the question the wizard opens on, and `settle` only
    // seeds follow-ups (see `isFollowUp`). Declared anyway because the type demands it of
    // every single-select question, and "skip" is what neutral means here — it is the one
    // answer that plans nothing but the four roots.
    defaultOption: () => "skip",
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
    // Freelance income does not imply a separate set of business expense accounts.
    defaultOption: () => "no",
    options: () => YES_NO,
  },
  {
    id: "housing", section: "home", kind: "one",
    visibleWhen: answered,
    // The only housing answer that plans nothing. "rent" adds a Rent line, "mortgage" adds
    // a mortgage liability and its interest, and even "own" opens a Housing group with
    // utilities and repairs — each of those would be the wizard telling a user who has not
    // reached this question yet what they pay for their home. "family" is exactly as
    // silent as no answer at all (`planStarterBook` skips the group for it, and it is also
    // the one answer that keeps `buildingFees` hidden, so nothing cascades from it), which
    // is what lets `housing` keep the same invariant as every other follow-up rather than
    // becoming a visible question with no answer.
    defaultOption: () => "family",
    options: () => ["rent", "mortgage", "own", "family"],
  },
  {
    id: "buildingFees", section: "home", kind: "one",
    visibleWhen: (a) => answered(a) && a.housing !== null && a.housing !== "family",
    // Having a home does not imply a building-fee bill.
    defaultOption: () => "no",
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
    // Owning a car says nothing about owing money on it, and the "yes" branch plans a
    // liability: a debt the user never claimed to have.
    defaultOption: () => "no",
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
    // One bank account is what "I have a bank account" said; a second one is not.
    defaultOption: () => "no",
    options: () => YES_NO,
  },
  {
    id: "cardCount", section: "accounts", kind: "one",
    visibleWhen: (a) => answered(a) && a.money.includes("card"),
    // Ticking "credit card" does assert a card, so the neutral answer here is not "none"
    // (there is no such option) but the lowest count the tick already implies.
    defaultOption: () => "1",
    options: () => ["1", "2", "3"],
  },
  {
    id: "fxCurrency", section: "accounts", kind: "one",
    visibleWhen: (a) => answered(a) && a.money.includes("fx"),
    // Ticking "an account in another currency" asserts the account; some currency must
    // stand for "another one", and every option here is equally a guess, so the first
    // offered is as neutral as it gets. It depends on the home currency, which is why
    // defaults are functions: the book's own currency is never among the choices.
    defaultOption: (a, home) => CURRENCIES.filter((c) => c !== home)[0],
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
 * id becomes a stored value in exactly one place, whoever chose the option. The one case
 * that can return its input unchanged is `household`, and seeding never reaches it:
 * `settle` only seeds follow-ups (see `isFollowUp`) and `household` is visible from the
 * start, so the no-op below cannot stall the settling loop. */
function setAnswer(a: Answers, id: QuestionId, option: string): Answers {
  let next: Answers;
  switch (id) {
    case "household": {
      const household = option as Household;
      // Re-tapping the household already chosen is a no-op, not a reset. Changing the
      // household *does* re-seed extras by design — a family's suggestions are not a
      // solo's — but tapping the selected option changes nothing the user can see, so it
      // must not silently throw away extras they ticked afterwards. Returning `a` itself
      // (not a fresh object) is also what makes the tap free of a re-render.
      if (household === a.household) return a;
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
 * Seeding: every visible single-select follow-up has an answer — the one its question
 * declares as `defaultOption`, which is the option that adds nothing beyond what the user
 * has already said. The default is declared rather than inferred from the option list
 * because render order is not plan semantics: reading the first option would have the
 * wizard assert a car loan because "yes" happens to be drawn before "no".
 * This is the invariant the planner relies on: it reads `a.cardCount !== null`
 * and `a.fxCurrency !== null`, and a visible question with no answer is exactly how a
 * ticked "credit card" used to create nothing when the user jumped past its follow-up
 * instead of walking through it. Holding it here rather than gating navigation means it
 * holds for *every* route through the wizard, including ones the screen has yet to invent.
 *
 * Runs to a fixpoint rather than one sweep over `QUESTIONS`, so nothing here depends on
 * prerequisites being listed before their dependents: pruning one answer can change what a
 * later question allows (clearing `income` down to no "freelance" hides `trackBusiness`
 * too), and a seeded answer could equally reveal the next question. No default does that
 * today — every one of them is the answer that adds nothing, and `housing`'s "family" is
 * precisely the option that keeps `buildingFees` hidden — but the loop does not depend on
 * that staying true. It keeps going until a full pass changes nothing, and terminates
 * because the only answer whose value narrows another question's options is `household`,
 * and `household` is never seeded.
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
      if (allowed.size === 0) continue;
      out = setAnswer(out, q.id, q.defaultOption(out, homeCurrency));
      changed = true;
    }
  }
  return out;
}
