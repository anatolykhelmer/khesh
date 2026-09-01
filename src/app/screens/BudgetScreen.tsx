import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  budgetRange,
  parseBudgetState,
  setPeriodKind,
  shiftBudgetState,
  toBudgetEditParams,
  toBudgetParams,
  type BudgetState,
} from "../budget-state";
import { ChevronBack, ChevronForward } from "../components/icons";
import { Ltr } from "../components/Ltr";
import { formatMinor, monthLabel } from "../format";
import { useLedger } from "../ledger-context";

export function BudgetScreen() {
  const { t } = useTranslation();
  const { book, app } = useLedger();
  const [params, setParams] = useSearchParams();

  if (!book) return null;

  const currentBook = book;
  const state = parseBudgetState(params);
  const result = app.budgetReport(currentBook, state.period, budgetRange(state));

  function write(next: BudgetState) {
    setParams(toBudgetParams(next));
  }

  if (!result.ok) {
    return (
      <main className="screen">
        <div className="screen-head">
          <Link className="icon-button back-button" to="/dashboard" aria-label={t("budget.backToDashboard")}>
            <ChevronBack />
          </Link>
          <h1>{t("budget.title")}</h1>
        </div>
        <p className="muted">{t("budget.couldNotLoad")}</p>
      </main>
    );
  }

  const report = result.value;
  const unbudgeted = Object.entries(report.unbudgeted);

  return (
    <main className="screen">
      <div className="screen-head">
        <Link className="icon-button back-button" to="/dashboard" aria-label={t("budget.backToDashboard")}>
          <ChevronBack />
        </Link>
        <h1>{t("budget.title")}</h1>
      </div>
      <div className="pills">
        <button
          type="button"
          className={state.period === "month" ? "pill on" : "pill"}
          onClick={() => write(setPeriodKind(state, "month"))}
        >
          {t("budget.periodMonth")}
        </button>
        <button
          type="button"
          className={state.period === "year" ? "pill on" : "pill"}
          onClick={() => write(setPeriodKind(state, "year"))}
        >
          {t("budget.periodYear")}
        </button>
      </div>
      <div className="month-nav">
        <button
          type="button"
          className="twisty"
          aria-label={t("budget.previousPeriod")}
          onClick={() => write(shiftBudgetState(state, -1))}
        >
          <ChevronBack />
        </button>
        <span>
          {state.period === "month"
            ? `${monthLabel(state.month)} ${state.year}`
            : String(state.year)}
        </span>
        <button
          type="button"
          className="twisty"
          aria-label={t("budget.nextPeriod")}
          onClick={() => write(shiftBudgetState(state, 1))}
        >
          <ChevronForward />
        </button>
      </div>
      {report.rows.length === 0 ? (
        <p className="muted">{t("budget.empty")}</p>
      ) : (
        <ul className="budget-list group">
          {report.rows.map((row) => {
            const used = Math.max(0, Math.min(100, Math.round((row.spent / row.limit) * 100)));
            const over = row.remaining < 0;
            const to = `/budget/edit?${toBudgetEditParams(state, {
              accountId: row.accountId,
              currency: row.currency,
            }).toString()}`;
            return (
              <li key={`${row.accountId}:${row.currency}`}>
                <Link className={over ? "budget-row over" : "budget-row"} to={to}>
                  <span className="budget-name">{row.name}</span>
                  <span className="budget-figures">
                    <Ltr>
                      {`${formatMinor(row.spent, row.currency)} / ${formatMinor(row.limit, row.currency)}`}
                    </Ltr>
                  </span>
                  <span className="budget-bar" aria-hidden="true">
                    <span style={{ inlineSize: `${used}%` }} />
                  </span>
                  <span className="budget-note">
                    {over ? t("budget.over") : t("budget.remaining")}{" "}
                    <Ltr>{formatMinor(Math.abs(row.remaining), row.currency)}</Ltr>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {unbudgeted.map(([currency, amount]) => (
        <p key={currency} className="muted budget-unbudgeted">
          {t("budget.unbudgeted")} <Ltr>{formatMinor(amount, currency)}</Ltr>
        </p>
      ))}
      <Link
        className="secondary link-button budget-add"
        to={`/budget/new?${toBudgetParams(state).toString()}`}
      >
        {t("budget.addLimit")}
      </Link>
    </main>
  );
}
