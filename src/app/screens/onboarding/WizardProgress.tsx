import { useTranslation } from "react-i18next";
import { SECTIONS, type SectionId } from "../../onboarding/questionnaire";

/** The fixed section list with the current one marked. Any section already visited is
 * a button back to that section's first step, in either direction — jumping forward to
 * a section seen earlier is fine, since nothing about it is skipped; the wizard only
 * refuses a jump to a section that has never been reached, because that would skip
 * questions whose answers shape the plan. */
export function WizardProgress({
  current,
  reached,
  busy,
  onJump,
}: {
  current: SectionId;
  /** Sections at or before the furthest one the user has seen, filtered down to the
   * ones `visibleSteps` still offers for the current answers — the caller's job, not
   * this component's, since only the caller has the answers. */
  reached: readonly SectionId[];
  busy: boolean;
  onJump: (section: SectionId) => void;
}) {
  const { t } = useTranslation();
  return (
    <ol className="wizard-progress" aria-label={t("onboarding.wizard.progressLabel")}>
      {SECTIONS.map((section) => {
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
