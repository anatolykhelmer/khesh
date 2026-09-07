import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { todayCalendarDate } from "../../service/dates";
import { ChevronBack } from "../components/icons";
import { DueRowItem } from "../components/DueRowItem";
import { Ltr } from "../components/Ltr";
import { formatDate, formatMinor } from "../format";
import { useLedger } from "../ledger-context";
import { ruleRows } from "../recurring-state";
import { useLedgerMutation } from "../use-ledger-mutation";

export function RecurringScreen() {
  const { t } = useTranslation();
  const { book, app } = useLedger();
  const today = todayCalendarDate();

  const due = useMemo(() => (book ? app.dueRows(book, today) : []), [book, app, today]);
  const rules = useMemo(() => (book ? ruleRows(book, today) : []), [book, today]);
  const { run, busy } = useLedgerMutation();

  if (!book) return null;
  const currentBook = book;

  function scheduleLabel(every: number, unit: "week" | "month" | "year"): string {
    const key = unit === "week" ? "recurring.everyWeek" : unit === "month" ? "recurring.everyMonth" : "recurring.everyYear";
    return t(key, { count: every });
  }

  return (
    <main className="screen">
      <div className="screen-head">
        <Link className="icon-button back-button" to="/dashboard" aria-label={t("recurring.backToDashboard")}>
          <ChevronBack />
        </Link>
        <h1>{t("recurring.title")}</h1>
      </div>

      {due.length > 0 ? (
        <>
          <h2 className="section-label">{t("recurring.dueTitle")}</h2>
          <ul className="due-list group">
            {due.map((row) => (
              <DueRowItem
                key={row.entryId}
                row={row}
                busy={busy}
                onPost={() => run(() => app.postOccurrence(currentBook, row.ruleId, row.date))}
                onSkip={() => run(() => app.skipOccurrence(currentBook, row.ruleId, row.date))}
                onDefer={() => run(() => app.deferOccurrence(currentBook, row.ruleId, row.date))}
              />
            ))}
          </ul>
        </>
      ) : null}

      <h2 className="section-label">{t("recurring.rulesTitle")}</h2>
      {rules.length === 0 ? (
        <p className="muted">{t("recurring.empty")}</p>
      ) : (
        <ul className="rule-list group">
          {rules.map((rule) => (
            <li key={rule.id}>
              <Link className="rule-row" to={`/recurring/${rule.id}/edit`}>
                <span className="rule-name">{rule.description}</span>
                <span className="rule-figure">
                  <Ltr>{formatMinor(rule.total, rule.currency)}</Ltr>
                </span>
                <span className="muted">
                  {scheduleLabel(rule.every, rule.unit)}
                  {rule.paused ? (
                    <> · {t("recurring.paused")}</>
                  ) : rule.next ? (
                    <>
                      {" · "}
                      {t("recurring.next")} <Ltr>{formatDate(rule.next)}</Ltr>
                    </>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Link className="secondary link-button" to="/recurring/new">
        {t("recurring.add")}
      </Link>
    </main>
  );
}
