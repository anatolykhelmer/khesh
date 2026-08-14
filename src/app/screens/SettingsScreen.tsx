import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { todayCalendarDate } from "../../service/dates";
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
        <h1>{t("settings.title")}</h1>
      </div>

      <section className="settings-section">
        <button type="button" className="secondary" onClick={onExport}>
          {t("settings.exportButton")}
        </button>
        <p className="muted">{t("settings.exportHint")}</p>
      </section>

      <section className="settings-section">
        <ImportBookButton
          label={t("settings.importButton")}
          confirmText={t("settings.importConfirm")}
          onSuccess={() => navigate("/dashboard")}
        />
        <p className="muted">{t("settings.importHint")}</p>
      </section>
    </main>
  );
}
