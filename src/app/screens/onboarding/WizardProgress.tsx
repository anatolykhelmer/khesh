import { useTranslation } from "react-i18next";
import { SECTIONS, type SectionId } from "../../onboarding/questionnaire";

/** The sections the current answers actually have, with the current one marked. Any
 * section already visited is a button back to that section's first step, in either
 * direction — jumping forward to a section seen earlier is fine, since nothing about it
 * is skipped; the wizard only refuses a jump to a section that has never been reached,
 * because that would skip questions whose answers shape the plan. */
export function WizardProgress({
  current,
  sections,
  reached,
  busy,
  onJump,
}: {
  current: SectionId;
  /** The sections `visibleSteps` offers for the current answers — the caller's job, not
   * this component's, since only the caller has the answers. Answering Skip leaves three;
   * rendering all eight would show five steps that no longer exist and have a screen
   * reader announce them as steps still to come. */
  sections: readonly SectionId[];
  /** Those of them at or before the furthest section the user has seen. */
  reached: readonly SectionId[];
  busy: boolean;
  onJump: (section: SectionId) => void;
}) {
  const { t } = useTranslation();
  // Filtered out of SECTIONS rather than mapped from the caller's array, so the bar stays
  // one ordered walk of the wizard however the caller assembled its list, and so the
  // current section is in it even if it somehow is not: a progress bar that renders
  // nothing, or that renders steps in a shifting order, is worse than one extra label.
  const shown = SECTIONS.filter((s) => s === current || sections.includes(s));
  return (
    <ol className="wizard-progress" aria-label={t("onboarding.wizard.progressLabel")}>
      {shown.map((section) => {
        const isCurrent = section === current;
        const canJump = reached.includes(section) && !isCurrent;
        return (
          <li key={section} aria-current={isCurrent ? "step" : undefined}>
            {canJump ? (
              <button
                type="button"
                className="wizard-progress-link"
                disabled={busy}
                onClick={() => onJump(section)}
              >
                {t(`onboarding.wizard.section.${section}`)}
              </button>
            ) : (
              <span>{t(`onboarding.wizard.section.${section}`)}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
