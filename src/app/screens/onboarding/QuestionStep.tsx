import { useTranslation } from "react-i18next";
import type { CurrencyCode } from "../../../kernel";
import { CURRENCIES } from "../../currencies";
import { selectedOptions, type Answers, type Question } from "../../onboarding/questionnaire";

// `fxCurrency`'s options are currency codes, not option-id key tails — this question is
// the only one where an option renders as itself rather than through `optionKey`. Built
// from the same list the rest of the app offers, so a currency added there is rendered
// the same way here instead of falling through to a raw missing-key string.
const CURRENCY_CODES = new Set<string>(CURRENCIES);

function optionKey(question: Question, option: string): string {
  if (option === "yes" || option === "no") return `onboarding.wizard.q.yesNo.${option}`;
  return `onboarding.wizard.q.${question.id}.${option}`;
}

export function QuestionStep({
  question,
  answers,
  homeCurrency,
  busy,
  onOption,
  onBack,
  onNext,
}: {
  question: Question;
  answers: Answers;
  homeCurrency: CurrencyCode;
  busy: boolean;
  onOption: (option: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  const selected = selectedOptions(answers, question.id);
  const options = question.options(answers, homeCurrency);
  const many = question.kind === "many";
  // A "one" question must be answered before moving on; a "many" question may be left
  // empty (nothing chosen is a valid answer: "no car, no lease, no public transport").
  const canProceed = many || selected.length > 0;
  return (
    <>
      <h1>{t(`onboarding.wizard.q.${question.id}.title`)}</h1>
      {/* Native inputs in a fieldset, the app's established shape for a choice (see
          `AccountKindChoice`): radios for "one", checkboxes for "many". That is where the
          arrow keys, the checked state and the group semantics come from — the column of
          buttons under `role="listbox"` that stood here promised an arrow-key listbox and
          was not one. The heading carries the question, so the legend must not: it says
          the one thing the heading cannot, which is how many options may be picked. */}
      <fieldset className="currency-list group">
        <legend className="visually-hidden">
          {t(many ? "onboarding.wizard.chooseAny" : "onboarding.wizard.chooseOne")}
        </legend>
        {options.map((option) => {
          const isSelected = selected.includes(option);
          return (
            <label key={option} className={isSelected ? "choice selected" : "choice"}>
              <span>{CURRENCY_CODES.has(option) ? option : t(optionKey(question, option))}</span>
              <input
                type={many ? "checkbox" : "radio"}
                // One radio group per question, so arrow keys move within this question
                // and nowhere else. Question ids are unique and only one step is mounted.
                name={question.id}
                checked={isSelected}
                disabled={busy}
                onChange={() => onOption(option)}
              />
            </label>
          );
        })}
      </fieldset>
      <div className="wizard-nav">
        <button type="button" className="secondary" disabled={busy} onClick={onBack}>
          {t("onboarding.wizard.back")}
        </button>
        <button type="button" className="primary" disabled={busy || !canProceed} onClick={onNext}>
          {t("onboarding.wizard.next")}
        </button>
      </div>
    </>
  );
}
