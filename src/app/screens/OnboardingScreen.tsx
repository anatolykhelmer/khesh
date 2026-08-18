import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CurrencyCode } from "../../kernel";
import { CURRENCIES } from "../currencies";
import { ImportBookButton } from "../components/ImportBookButton";
import type { AppLanguage } from "../i18n";
import { setLanguage } from "../i18n";
import { useLedger } from "../ledger-context";
import { useLedgerMutation } from "../use-ledger-mutation";

export function OnboardingScreen() {
  const { t, i18n } = useTranslation();
  const { app } = useLedger();
  const { busy: saving, run } = useLedgerMutation();
  const [language, setLanguageChoice] = useState<AppLanguage>(
    i18n.language === "he" ? "he" : "en",
  );
  const [currency, setCurrency] = useState<CurrencyCode>("ILS");
  // The import button drives its own async work, so the screen's disabled state is
  // the union of both: either one running must gate the other.
  const [importing, setImporting] = useState(false);
  const busy = saving || importing;

  function chooseLanguage(next: AppLanguage) {
    setLanguageChoice(next);
    setLanguage(next);
  }

  async function onContinue() {
    setLanguage(language);
    await run(() => app.createHousehold(currency));
  }

  return (
    <main className="screen onboarding">
      <p className="brand">Khesh</p>

      <h1>{t("onboarding.languageTitle")}</h1>
      <div className="currency-list" role="listbox" aria-label={t("onboarding.languageListLabel")}>
        <button
          type="button"
          role="option"
          aria-selected={language === "en"}
          className={language === "en" ? "choice selected" : "choice"}
          onClick={() => chooseLanguage("en")}
        >
          {t("onboarding.languageEnglish")}
        </button>
        <button
          type="button"
          role="option"
          aria-selected={language === "he"}
          className={language === "he" ? "choice selected" : "choice"}
          onClick={() => chooseLanguage("he")}
        >
          {t("onboarding.languageHebrew")}
        </button>
      </div>

      <h1>{t("onboarding.currencyTitle")}</h1>
      <p className="muted">{t("onboarding.currencySubtitle")}</p>
      <div className="currency-list" role="listbox" aria-label={t("onboarding.currencyListLabel")}>
        {CURRENCIES.map((code) => (
          <button
            key={code}
            type="button"
            role="option"
            aria-selected={currency === code}
            className={currency === code ? "choice selected" : "choice"}
            onClick={() => setCurrency(code)}
          >
            {code}
          </button>
        ))}
      </div>
      <button type="button" className="primary" disabled={busy} onClick={onContinue}>
        {t("onboarding.continue")}
      </button>
      <ImportBookButton
        label={t("onboarding.restore")}
        disabled={busy}
        onBusyChange={setImporting}
      />
    </main>
  );
}
