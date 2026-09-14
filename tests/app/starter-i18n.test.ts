import { describe, expect, it } from "vitest";
import en from "../../src/app/locales/en.json";
import { CURRENCIES } from "../../src/app/currencies";
import {
  applyOption,
  EMPTY_ANSWERS,
  QUESTIONS,
  SECTIONS,
  selectedOptions,
  type Answers,
} from "../../src/app/onboarding/questionnaire";
import { planStarterBook } from "../../src/service/starter-plan";

function lookup(path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), en);
}

// `fxCurrency`'s options are currency codes, which QuestionStep renders as themselves
// rather than through an i18n key. Derived from the same list QuestionStep derives its
// own set from, so adding a fourth currency does not fail this test spuriously.
const CURRENCY_CODES = new Set<string>(CURRENCIES);

describe("starter wizard strings", () => {
  it("every section, question and option has an English string", () => {
    for (const s of SECTIONS) expect(typeof lookup(`onboarding.wizard.section.${s}`), s).toBe("string");
    for (const q of QUESTIONS) {
      expect(typeof lookup(`onboarding.wizard.q.${q.id}.title`), q.id).toBe("string");
      // Options may depend on answers; union them over a few representative states.
      const states: Answers[] = ["solo", "couple", "family"].map((h) => applyOption(EMPTY_ANSWERS, "household", h, "ILS"));
      for (const a of states) {
        for (const o of q.options(a, "ILS")) {
          if (CURRENCY_CODES.has(o)) continue;
          const key = o === "yes" || o === "no" ? `onboarding.wizard.q.yesNo.${o}` : `onboarding.wizard.q.${q.id}.${o}`;
          expect(typeof lookup(key), key).toBe("string");
        }
      }
    }
    const chrome = ["next", "back", "createBook", "summaryTitle", "summaryHint", "progressLabel",
      // The fieldset legends QuestionStep names its option groups with.
      "chooseOne", "chooseAny"];
    for (const k of chrome) {
      expect(typeof lookup(`onboarding.wizard.${k}`), k).toBe("string");
    }
  });

  it("every account name the planner can emit has an English string", () => {
    // The widest plan: every 'many' option on, every follow-up yes, three cards, USD account.
    let a = applyOption(EMPTY_ANSWERS, "household", "family", "ILS");
    for (const q of QUESTIONS) {
      if (!q.visibleWhen(a) || q.kind !== "many") continue;
      for (const o of q.options(a, "ILS")) {
        if (!selectedOptions(a, q.id).includes(o)) a = applyOption(a, q.id, o, "ILS");
      }
    }
    for (const q of QUESTIONS) {
      if (!q.visibleWhen(a) || q.kind !== "one" || q.id === "household") continue;
      const opts = q.options(a, "ILS");
      // "yes" for every follow-up, three cards, a mortgage, the first foreign currency.
      const pick = q.id === "cardCount" ? "3" : q.id === "housing" ? "mortgage" : opts[0];
      a = applyOption(a, q.id, pick, "ILS");
    }
    // Also the single-leg variants the widest plan cannot show at the same time.
    const variants = [
      a,
      applyOption(applyOption(EMPTY_ANSWERS, "household", "solo", "ILS"), "housing", "rent", "ILS"),
      applyOption(applyOption(EMPTY_ANSWERS, "household", "solo", "ILS"), "housing", "mortgage", "ILS"),
      applyOption(applyOption(EMPTY_ANSWERS, "household", "solo", "ILS"), "housing", "own", "ILS"),
    ];
    for (const v of variants) {
      for (const item of planStarterBook(v, "ILS")) {
        expect(typeof lookup(item.nameKey), item.nameKey).toBe("string");
      }
    }
  });
});
