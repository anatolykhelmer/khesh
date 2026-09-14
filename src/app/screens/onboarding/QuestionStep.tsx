import { useTranslation } from "react-i18next";
import type { CurrencyCode } from "../../../kernel";
import { Check } from "../../components/icons";
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
      <div
        className="currency-list group"
        role="listbox"
        aria-multiselectable={many || undefined}
        aria-label={t(`onboarding.wizard.q.${question.id}.title`)}
      >
        {options.map((option) => {
          const isSelected = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={isSelected}
              className={isSelected ? "choice selected" : "choice"}
              onClick={() => onOption(option)}
            >
              <span>{CURRENCY_CODES.has(option) ? option : t(optionKey(question, option))}</span>
              {isSelected ? <Check /> : null}
            </button>
          );
        })}
      </div>
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
