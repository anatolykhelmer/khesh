import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { todayCalendarDate } from "../../service/dates";
import { ChevronBack } from "../components/icons";
import { ImportBookButton } from "../components/ImportBookButton";
import { useLedger } from "../ledger-context";

export function SettingsScreen() {
  const { t } = useTranslation();
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
    </main>
  );
}
