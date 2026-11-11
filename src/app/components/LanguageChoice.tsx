import { useTranslation } from "react-i18next";
import type { AppLanguage } from "../i18n";

/**
 * The English / עברית picker, shared by onboarding and Settings. A fieldset of native
 * radios — the app's established shape for a choice (see `AccountKindChoice`). The
 * caller supplies the visible heading; the legend only names the group, so nothing is
 * announced twice.
 */
export function LanguageChoice({
  name,
  value,
  disabled,
  onChange,
}: {
  name: string;
  value: AppLanguage;
  disabled?: boolean;
  onChange: (language: AppLanguage) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="currency-list group">
      <legend className="visually-hidden">{t("onboarding.languageListLabel")}</legend>
      {(["en", "he"] as const).map((l) => (
        <label key={l} className={value === l ? "choice selected" : "choice"}>
          <span>{t(l === "en" ? "onboarding.languageEnglish" : "onboarding.languageHebrew")}</span>
          <input
            type="radio"
            name={name}
            checked={value === l}
            disabled={disabled}
            onChange={() => onChange(l)}
          />
        </label>
      ))}
    </fieldset>
  );
}
