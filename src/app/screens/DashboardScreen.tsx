import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { currentYearMonth, formatYearMonth, monthRange } from "../../service/dates";
import { formatMinor, monthLabel } from "../format";
import { currencySymbol } from "../currencies";
import { Ltr } from "../components/Ltr";
import { useLedger } from "../ledger-context";

export function DashboardScreen() {
  const { t } = useTranslation();
  const { book, app } = useLedger();
  const [{ year, month }, setYearMonth] = useState(currentYearMonth());

  if (!book) return null;

  const currentBook = book;

  function shiftMonth(delta: number) {
    setYearMonth((current) => {
      let { year, month } = current;
      month += delta;
      if (month < 1) {
        month = 12;
        year -= 1;
      } else if (month > 12) {
        month = 1;
        year += 1;
      }
      return { year, month };
    });
  }

  const range = monthRange(year, month);
  const result = app.periodTotals(currentBook, range);
  const rows = result.ok
    ? Object.entries(result.value).sort(([a], [b]) => {
        if (a === currentBook.homeCurrency) return -1;
        if (b === currentBook.homeCurrency) return 1;
        return a.localeCompare(b);
      })
    : [];

  return (
    <main className="screen">
      <h1>{t("dashboard.title")}</h1>
      <div className="month-nav">
        <button
          type="button"
          className="twisty"
          aria-label={t("common.previousMonth")}
          onClick={() => shiftMonth(-1)}
        >
          ◂
        </button>
        <span>
          {monthLabel(month)} {year}
        </span>
        <button
          type="button"
          className="twisty"
          aria-label={t("common.nextMonth")}
          onClick={() => shiftMonth(1)}
        >
          ▸
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="muted">{t("dashboard.couldNotLoadTotals")}</p>
      ) : (
        rows.map(([currency, totals]) => (
          <section key={currency}>
            <h2>{currencySymbol(currency)}</h2>
            <dl className="detail-list">
              <div>
                <dt>{t("dashboard.income")}</dt>
                <dd>
                  <Ltr>{formatMinor(totals.income, currency)}</Ltr>
                </dd>
              </div>
              <div>
                <dt>{t("dashboard.expenses")}</dt>
                <dd>
                  <Link
                    className="stats-link"
                    to={`/stats?month=${formatYearMonth({ year, month })}&currency=${currency}`}
                  >
                    <Ltr>{formatMinor(totals.expense, currency)}</Ltr>
                  </Link>
                </dd>
              </div>
            </dl>
          </section>
        ))
      )}
    </main>
  );
}
