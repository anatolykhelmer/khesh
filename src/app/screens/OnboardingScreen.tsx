import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CurrencyCode } from "../../kernel";
import { CURRENCIES } from "../currencies";
import { Check } from "../components/icons";
import { ConnectDrive } from "../components/ConnectDrive";
import { ImportBookButton } from "../components/ImportBookButton";
import type { AppLanguage } from "../i18n";
import { setLanguage } from "../i18n";
import { useLedger } from "../ledger-context";
import { useSync } from "../sync/sync-context";
import { useLedgerMutation } from "../use-ledger-mutation";

export function OnboardingScreen() {
  const { t, i18n } = useTranslation();
  const { app } = useLedger();
  const sync = useSync();
  const { busy: saving, run } = useLedgerMutation();
  const [language, setLanguageChoice] = useState<AppLanguage>(
    i18n.language === "he" ? "he" : "en",
  );
  const [currency, setCurrency] = useState<CurrencyCode>("ILS");
  // The import button drives its own async work, so the screen's disabled state is
  // the union of both: either one running must gate the other.
  const [importing, setImporting] = useState(false);
  // Connecting Drive belongs in that union too, and it is the half that costs data.
  // `createHousehold` and `applyFirstConnect` both take the sync lock, so they cannot
  // interleave — but they can still run back to back: `useRemote` saves the Drive book,
  // releases, and Continue writes a seed over the same key, which `finalizeConnect` then
  // arms an engine to upload over the real file. Unmounting this screen does not cancel
  // an in-flight `createHousehold` either. A plan merely *on screen* is enough to block:
  // it is one tap from that write, and `sync.applying` only covers the tap after.
  const busy = saving || importing || sync.applying || sync.pendingInspection !== null;

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
      <div
        className="currency-list group"
        role="listbox"
        aria-label={t("onboarding.languageListLabel")}
      >
        <button
          type="button"
          role="option"
          aria-selected={language === "en"}
          className={language === "en" ? "choice selected" : "choice"}
          onClick={() => chooseLanguage("en")}
        >
          <span>{t("onboarding.languageEnglish")}</span>
          {language === "en" ? <Check /> : null}
        </button>
        <button
          type="button"
          role="option"
          aria-selected={language === "he"}
          className={language === "he" ? "choice selected" : "choice"}
          onClick={() => chooseLanguage("he")}
        >
          <span>{t("onboarding.languageHebrew")}</span>
          {language === "he" ? <Check /> : null}
        </button>
      </div>

      <h1>{t("onboarding.currencyTitle")}</h1>
      <p className="muted">{t("onboarding.currencySubtitle")}</p>
      <div
        className="currency-list group"
        role="listbox"
        aria-label={t("onboarding.currencyListLabel")}
      >
        {CURRENCIES.map((code) => (
          <button
            key={code}
            type="button"
            role="option"
            aria-selected={currency === code}
            className={currency === code ? "choice selected" : "choice"}
            onClick={() => setCurrency(code)}
          >
            <span>{code}</span>
            {currency === code ? <Check /> : null}
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
      {/* Only this screen's own writes: `ConnectDrive` adds `sync.applying` itself, and
          passing the plan-on-screen half would disable the very choices it renders. */}
      <ConnectDrive disabled={saving || importing} />
      <a className="onboarding-about" href="/about.html" target="_blank" rel="noopener">
        {t("onboarding.aboutLink")}
      </a>
    </main>
  );
}
