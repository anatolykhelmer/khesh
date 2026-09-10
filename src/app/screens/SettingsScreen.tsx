import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { todayCalendarDate } from "../../service/dates";
import { ChevronBack } from "../components/icons";
import { DangerZone } from "../components/DangerZone";
import { ImportBookButton } from "../components/ImportBookButton";
import { SyncSection } from "../components/SyncSection";
import { useLedger } from "../ledger-context";

export function SettingsScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { book, app } = useLedger();
  // The danger zone's erase, lifted so the sync block above it can gate on the same flag —
  // `ImportBookButton`'s `onBusyChange` idiom, and the same reason: this screen owns the
  // layout that puts a first connect and an erase side by side, so it is the only place
  // that can tell one about the other. `performReset` runs on for the whole of `resetAll()`
  // after the `disconnect()` it starts with, and `SyncSection` renders an enabled Connect
  // row for all of it unless it is told. See `SyncSection`'s doc comment for the failure.
  //
  // Both props below are required rather than optional, so that dropping either end of
  // this — the only guard on that window — is a `tsc` error here. It was neither a test
  // failure nor a lint error before: deleting both left 724/724 green.
  const [erasing, setErasing] = useState(false);

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

      <SyncSection disabled={erasing} />

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
      </ul>

      <DangerZone onBusyChange={setErasing} />
    </main>
  );
}
