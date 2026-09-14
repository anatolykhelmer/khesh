import { useTranslation } from "react-i18next";
import { SECTIONS, type SectionId } from "../../onboarding/questionnaire";

/** The fixed section list with the current one marked. Sections the user has passed are
 * buttons back to that section's first step; the rest are plain text — the wizard only
 * allows jumping backwards, because a forward jump would skip questions whose answers
 * shape the plan. */
export function WizardProgress({
  current,
  reached,
  onJump,
}: {
  current: SectionId;
  /** Sections at or before the furthest one the user has seen. */
  reached: readonly SectionId[];
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
              <button type="button" className="wizard-progress-link" onClick={() => onJump(section)}>
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
