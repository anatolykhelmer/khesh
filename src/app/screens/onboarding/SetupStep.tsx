import { useTranslation } from "react-i18next";
import type { CurrencyCode } from "../../../kernel";
import { CURRENCIES } from "../../currencies";
import { Check } from "../../components/icons";
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
      <h1>{t("onboarding.languageTitle")}</h1>
      <div className="currency-list group" role="listbox" aria-label={t("onboarding.languageListLabel")}>
        {(["en", "he"] as const).map((l) => (
          <button
            key={l}
            type="button"
            role="option"
            aria-selected={language === l}
            className={language === l ? "choice selected" : "choice"}
            onClick={() => onLanguage(l)}
          >
            <span>{t(l === "en" ? "onboarding.languageEnglish" : "onboarding.languageHebrew")}</span>
            {language === l ? <Check /> : null}
          </button>
        ))}
      </div>

      <h1>{t("onboarding.currencyTitle")}</h1>
      <p className="muted">{t("onboarding.currencySubtitle")}</p>
      <div className="currency-list group" role="listbox" aria-label={t("onboarding.currencyListLabel")}>
        {CURRENCIES.map((code) => (
          <button
            key={code}
            type="button"
            role="option"
            aria-selected={currency === code}
            className={currency === code ? "choice selected" : "choice"}
            onClick={() => onCurrency(code)}
          >
            <span>{code}</span>
            {currency === code ? <Check /> : null}
          </button>
        ))}
      </div>
      <button type="button" className="primary" disabled={busy} onClick={onNext}>
        {t("onboarding.wizard.next")}
      </button>
      <ImportBookButton label={t("onboarding.restore")} disabled={busy} onBusyChange={onImporting} />
      {/* Only this screen's own writes: `ConnectDrive` adds `sync.applying` itself, and
          passing the plan-on-screen half would disable the very choices it renders. */}
      <ConnectDrive disabled={saving || importing} />
      <a className="onboarding-about" href="/about.html" target="_blank" rel="noopener">
        {t("onboarding.aboutLink")}
      </a>
    </>
  );
}
