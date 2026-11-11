import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { todayCalendarDate } from "../../service/dates";
import { ChevronBack } from "../components/icons";
import { DangerZone } from "../components/DangerZone";
import { ImportBookButton } from "../components/ImportBookButton";
import { LanguageChoice } from "../components/LanguageChoice";
import { setLanguage } from "../i18n";
import { SyncSection } from "../components/SyncSection";
import { useLedger } from "../ledger-context";

export function SettingsScreen() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { book, app } = useLedger();

  if (!book) return null;

  const currentBook = book;

  function onExport() {
    const url = URL.createObjectURL(
      new Blob([app.exportJson(currentBook)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `khesh-${todayCalendarDate()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="screen">
      <div className="screen-head">
        <Link className="icon-button back-button" to="/dashboard" aria-label={t("budget.backToDashboard")}>
          <ChevronBack />
        </Link>
        <h1>{t("settings.title")}</h1>
      </div>

      {/* Per-device, never part of the book: each family member on a shared book keeps
          their own language. `useTranslation` re-renders on `languageChanged`, so the
          checked row follows `setLanguage` without local state. */}
      <h2 className="section-label">{t("settings.languageTitle")}</h2>
      <LanguageChoice
        name="settings-language"
        value={i18n.language === "he" ? "he" : "en"}
        onChange={setLanguage}
      />
      <p className="muted row-hint">{t("settings.languageHint")}</p>

      <ul className="settings-list group">
        <li className="settings-row">
          <button type="button" className="row-button" onClick={onExport}>
            {t("settings.exportButton")}
          </button>
          <p className="muted row-hint">{t("settings.exportHint")}</p>
        </li>
        <li className="settings-row">
          <ImportBookButton
            className="row-button"
            label={t("settings.importButton")}
            confirmText={t("settings.importConfirm")}
            onSuccess={() => navigate("/dashboard")}
          />
          <p className="muted row-hint">{t("settings.importHint")}</p>
        </li>
      </ul>

      <SyncSection />

      <ul className="settings-list group">
        <li className="settings-row">
          <a className="row-button" href="/about.html" target="_blank" rel="noopener">
            {t("settings.aboutLink")}
          </a>
        </li>
        <li className="settings-row">
          <a className="row-button" href="/privacy.html" target="_blank" rel="noopener">
            {t("settings.privacyLink")}
          </a>
        </li>
        <li className="settings-row">
          <a
            className="row-button"
            href="https://github.com/anatolykhelmer/khesh/discussions"
            target="_blank"
            rel="noopener"
          >
            {t("settings.feedbackLink")}
          </a>
          <p className="muted row-hint">{t("settings.feedbackHint")}</p>
        </li>
      </ul>

      <DangerZone />
    </main>
  );
}
