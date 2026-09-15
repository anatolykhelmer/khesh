import { useTranslation } from "react-i18next";
import type { CurrencyCode } from "../../../kernel";
import { CURRENCIES } from "../../currencies";
import { ConnectDrive } from "../../components/ConnectDrive";
import { ImportBookButton } from "../../components/ImportBookButton";
import type { AppLanguage } from "../../i18n";

export function SetupStep({
  language,
  currency,
  busy,
  saving,
  importing,
  onLanguage,
  onCurrency,
  onImporting,
  onNext,
}: {
  language: AppLanguage;
  currency: CurrencyCode;
  busy: boolean;
  saving: boolean;
  importing: boolean;
  onLanguage: (l: AppLanguage) => void;
  onCurrency: (c: CurrencyCode) => void;
  onImporting: (busy: boolean) => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {/* Both lists are fieldsets of native radios, the app's established shape for a
          choice (see `AccountKindChoice`). The heading carries the question; the legend
          names the group without repeating it, so nothing is announced twice. */}
      <h1>{t("onboarding.languageTitle")}</h1>
      <fieldset className="currency-list group">
        <legend className="visually-hidden">{t("onboarding.languageListLabel")}</legend>
        {(["en", "he"] as const).map((l) => (
          <label key={l} className={language === l ? "choice selected" : "choice"}>
            <span>{t(l === "en" ? "onboarding.languageEnglish" : "onboarding.languageHebrew")}</span>
            <input
              type="radio"
              name="onboarding-language"
              checked={language === l}
              disabled={busy}
              onChange={() => onLanguage(l)}
            />
          </label>
        ))}
      </fieldset>

      <h1>{t("onboarding.currencyTitle")}</h1>
      <p className="muted">{t("onboarding.currencySubtitle")}</p>
      <fieldset className="currency-list group">
        <legend className="visually-hidden">{t("onboarding.currencyListLabel")}</legend>
        {CURRENCIES.map((code) => (
          <label key={code} className={currency === code ? "choice selected" : "choice"}>
            <span>{code}</span>
            <input
              type="radio"
              name="onboarding-currency"
              checked={currency === code}
              disabled={busy}
              onChange={() => onCurrency(code)}
            />
          </label>
        ))}
      </fieldset>
      <button type="button" className="primary" disabled={busy} onClick={onNext}>
        {t("onboarding.wizard.next")}
      </button>
      <ImportBookButton label={t("onboarding.restore")} disabled={busy} onBusyChange={onImporting} />
      {/* Only the screen's own writes: `ConnectDrive` adds `activity.blocking` itself, and
          passing the plan-on-screen half would disable the very choices it renders.
          `saving` and `importing` are props rather than this step's own state because the
          writes are the *screen's* — `saving` is `OnboardingScreen`'s mutation, and the
          import runs on past this step through `onImporting`. That is the other half of
          BL-049 and the reason they are threaded down here separately from `busy`: `busy`
          already folds in the sync side, and handing it to `ConnectDrive` would disable
          the choice buttons on the strength of the very connect that opened them. */}
      <ConnectDrive disabled={saving || importing} />
      <a className="onboarding-about" href="/about.html" target="_blank" rel="noopener">
        {t("onboarding.aboutLink")}
      </a>
    </>
  );
}
