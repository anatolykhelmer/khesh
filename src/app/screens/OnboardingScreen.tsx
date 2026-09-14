import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CurrencyCode } from "../../kernel";
import type { AppLanguage } from "../i18n";
import { setLanguage } from "../i18n";
import { useLedger } from "../ledger-context";
import {
  applyOption,
  EMPTY_ANSWERS,
  nextStep,
  previousStep,
  QUESTIONS,
  sectionOf,
  SECTIONS,
  visibleSteps,
  type Answers,
  type SectionId,
  type Step,
} from "../onboarding/questionnaire";
import { planStarterBook, planTree } from "../../service/starter-plan";
import { useSync } from "../sync/sync-context";
import { useLedgerMutation } from "../use-ledger-mutation";
import { QuestionStep } from "./onboarding/QuestionStep";
import { SetupStep } from "./onboarding/SetupStep";
import { SummaryStep } from "./onboarding/SummaryStep";
import { WizardProgress } from "./onboarding/WizardProgress";

/**
 * The starter wizard. All branching lives in `questionnaire.ts` and all tree-building in
 * `starter-plan.ts`; this component holds the answers and asks those modules what to show.
 * No router: `App` renders this screen whenever there is no book, and the empty state has
 * no routes of its own.
 */
export function OnboardingScreen() {
  const { i18n } = useTranslation();
  const { app } = useLedger();
  const sync = useSync();
  const { busy: saving, run } = useLedgerMutation();
  const [language, setLanguageChoice] = useState<AppLanguage>(
    i18n.language === "he" ? "he" : "en",
  );
  const [currency, setCurrency] = useState<CurrencyCode>("ILS");
  const [answers, setAnswers] = useState<Answers>(EMPTY_ANSWERS);
  const [step, setStep] = useState<Step>("setup");
  // The furthest section index the user has reached, for the progress list's back-links.
  const [furthest, setFurthest] = useState(0);
  // The import button drives its own async work, so the screen's disabled state is
  // the union of both: either one running must gate the other.
  const [importing, setImporting] = useState(false);
  // Connecting Drive belongs in that union too, and it is the half that costs data.
  // `createHousehold` and `applyFirstConnect` both take the sync lock, so they cannot
  // interleave — but they can still run back to back: `useRemote` saves the Drive book,
  // releases, and Create book writes a seed over the same key, which `finalizeConnect`
  // then arms an engine to upload over the real file. Unmounting this screen does not
  // cancel an in-flight `createHousehold` either. A plan merely *on screen* is enough to
  // block: it is one tap from that write, and `sync.applying` only covers the tap after.
  const busy = saving || importing || sync.applying || sync.pendingInspection !== null;

  const plan = useMemo(() => planStarterBook(answers, currency), [answers, currency]);
  const tree = useMemo(() => planTree(plan), [plan]);
  const section = sectionOf(step);
  const reached = SECTIONS.slice(0, furthest + 1);

  function chooseLanguage(next: AppLanguage) {
    setLanguageChoice(next);
    setLanguage(next);
  }

  function goTo(next: Step) {
    setStep(next);
    setFurthest((f) => Math.max(f, SECTIONS.indexOf(sectionOf(next))));
  }

  function jumpToSection(target: SectionId) {
    const first = visibleSteps(answers).find((s) => sectionOf(s) === target);
    if (first !== undefined) setStep(first);
  }

  async function onCreate() {
    setLanguage(language);
    await run(() => app.createHousehold(currency, plan));
  }

  const question = QUESTIONS.find((q) => q.id === step);

  return (
    <main className="screen onboarding">
      <p className="brand">Khesh</p>
      <WizardProgress current={section} reached={reached} onJump={jumpToSection} />
      {step === "setup" ? (
        <SetupStep
          language={language}
          currency={currency}
          busy={busy}
          saving={saving}
          importing={importing}
          onLanguage={chooseLanguage}
          onCurrency={setCurrency}
          onImporting={setImporting}
          onNext={() => goTo(nextStep("setup", answers))}
        />
      ) : step === "summary" ? (
        <SummaryStep
          tree={tree}
          homeCurrency={currency}
          busy={busy}
          onBack={() => setStep(previousStep("summary", answers))}
          onCreate={() => void onCreate()}
        />
      ) : question !== undefined ? (
        <QuestionStep
          question={question}
          answers={answers}
          homeCurrency={currency}
          busy={busy}
          canGoBack
          onOption={(option) => setAnswers((a) => applyOption(a, question.id, option))}
          onBack={() => setStep(previousStep(question.id, answers))}
          onNext={() => goTo(nextStep(question.id, answers))}
        />
      ) : null}
    </main>
  );
}
