import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  currentYearMonth,
  formatYearMonth,
  monthRange,
  shiftYearMonth,
  todayCalendarDate,
  yearRange,
} from "../../service/dates";
import { formatMinor, monthLabel } from "../format";
import { currencySymbol } from "../currencies";
import { heroState } from "../dashboard-state";
import { expenseRootId } from "../stats-state";
import { DueRowItem } from "../components/DueRowItem";
import { Ltr } from "../components/Ltr";
import { ChevronBack, ChevronForward, Gear } from "../components/icons";
import { useLedger } from "../ledger-context";
import { useLedgerMutation } from "../use-ledger-mutation";

const TOP_CATEGORIES = 4;
const DASHBOARD_DUE_ROWS = 3;

export function DashboardScreen() {
  const { t } = useTranslation();
  const { book, app } = useLedger();
  const [{ year, month }, setYearMonth] = useState(currentYearMonth());
  const today = todayCalendarDate();
  // Deferred rows are filtered out here and only here: "Later" removes a row from this
  // card, but the recurring queue and the journal still show it.
  const due = useMemo(
    () => (book ? app.dueRows(book, today).filter((row) => !row.deferred) : []),
    [book, app, today],
  );
  const { busy, run } = useLedgerMutation();

  if (!book) return null;

  const currentBook = book;
  const period = formatYearMonth({ year, month });
  const range = monthRange(year, month);

  function shiftMonth(delta: number) {
    setYearMonth((current) => shiftYearMonth(current, delta));
  }

  const totalsResult = app.periodTotals(currentBook, range);
  const monthBudget = app.budgetReport(currentBook, "month", range);
  const yearBudget = app.budgetReport(currentBook, "year", yearRange(year));

  if (!totalsResult.ok || !monthBudget.ok) {
    return (
      <main className="screen">
        <h1>{t("dashboard.title")}</h1>
        <p className="muted">{t("dashboard.couldNotLoadTotals")}</p>
      </main>
    );
  }

  const totals = totalsResult.value;
  const hero = heroState(currentBook, totals, monthBudget.value);
  const home = currentBook.homeCurrency;

  const header = (
    <div className="screen-head">
      <h1>{t("dashboard.title")}</h1>
      <Link className="icon-button" to="/settings" aria-label={t("dashboard.settings")}>
        <Gear />
      </Link>
    </div>
  );

  // Always present, due rows or not — mirrors the budget hero's permanent `setLimit`
  // entry below so a book with no rules yet still has a door to `/recurring`. Shared
  // with the empty-book branch right below so a book whose only activity is recurring
  // rules is not stranded behind `heroState`'s "empty" case, which used to return
  // before this card was ever reached.
  const recurringSection =
    due.length > 0 ? (
      <>
        <h2 className="section-label">{t("dashboard.dueNow")}</h2>
        <ul className="due-list group">
          {due.slice(0, DASHBOARD_DUE_ROWS).map((row) => (
            <DueRowItem
              key={row.entryId}
              row={row}
              busy={busy}
              onPost={() => run(() => app.postOccurrence(currentBook, row.ruleId, row.date))}
            />
          ))}
        </ul>
        <Link className="secondary link-button" to="/recurring">
          {due.length > DASHBOARD_DUE_ROWS
            ? t("dashboard.dueMore", { count: due.length - DASHBOARD_DUE_ROWS })
            : t("dashboard.recurringLink")}
        </Link>
      </>
    ) : (
      <p className="hero-note dash-recurring-empty">
        <Link to="/recurring">{t("dashboard.recurringEmpty")}</Link>
      </p>
    );

  if (hero.kind === "empty") {
    return (
      <main className="screen">
        {header}
        <div className="dash-empty">
          <h2>{t("dashboard.emptyTitle")}</h2>
          <p>{t("dashboard.emptyBody")}</p>
          <Link className="primary link-button" to="/new">
            {t("dashboard.emptyAction")}
          </Link>
        </div>
        {recurringSection}
      </main>
    );
  }

  const homeTotals = totals[home] ?? { income: 0, expense: 0 };
  const net = homeTotals.income - homeTotals.expense;

  // Every currency other than the home one keeps its own section: FX lives per entry
  // line, so there is no rate to fold them into the hero with.
  const otherCurrencies = Object.entries(totals)
    .filter(([code]) => code !== home)
    .sort(([a], [b]) => a.localeCompare(b));

  const rootId = expenseRootId(currentBook);
  const breakdown = rootId ? app.periodBreakdown(currentBook, range, rootId, home) : null;
  const categories =
    breakdown && breakdown.ok
      ? [...breakdown.value.children]
          .filter((child) => child.amount > 0)
          .sort((a, b) => b.amount - a.amount)
          .slice(0, TOP_CATEGORIES)
      : [];

  const monthRows = monthBudget.value.rows;
  const yearRows = yearBudget.ok ? yearBudget.value.rows : [];
  // A category can carry both a monthly and an annual limit, so it can appear in both
  // reports. Count distinct accounts, not rows, or such a category is counted twice —
  // the bug fixed in 6d8a84a.
  const overAccountIds = new Set(
    [...monthRows, ...yearRows].filter((row) => row.remaining < 0).map((row) => row.accountId),
  );
  const overCount = overAccountIds.size;
  const monthOverCount = monthRows.filter((row) => row.remaining < 0).length;
  // If nothing is over monthly, the overrun must come from the annual report alone —
  // link to the year view so the tap does not land on a screen with nothing red on it.
  const budgetHref =
    monthOverCount === 0 && overCount > 0
      ? `/budget?period=year&year=${year}`
      : `/budget?period=month&month=${period}`;

  return (
    <main className="screen">
      {header}

      <div className="month-nav">
        <button
          type="button"
          className="twisty"
          aria-label={t("common.previousMonth")}
          onClick={() => shiftMonth(-1)}
        >
          <ChevronBack />
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
          <ChevronForward />
        </button>
      </div>

      {recurringSection}

      <p className="hero-label">{t("dashboard.spentIn", { month: monthLabel(month) })}</p>
      <Link
        className="hero-amount"
        to={`/stats?month=${period}&currency=${home}`}
        aria-label={`${t("dashboard.viewStats")}: ${formatMinor(hero.spent, home)}`}
      >
        <Ltr>{formatMinor(hero.spent, home)}</Ltr>
      </Link>

      {hero.kind === "budgeted" ? (
        <>
          <div className={hero.over ? "hero-bar over" : "hero-bar"}>
            <span style={{ inlineSize: `${hero.pct}%` }} />
          </div>
          <p className={hero.over ? "hero-note over" : "hero-note"}>
            {hero.over ? (
              <>
                {t("dashboard.overBudgetBy")}{" "}
                <Ltr>{formatMinor(hero.budgeted - hero.limit, home)}</Ltr>
              </>
            ) : (
              <>
                {t("dashboard.ofBudget", { percent: hero.pct })}{" "}
                <Ltr>{formatMinor(hero.limit, home)}</Ltr>
              </>
            )}
            {hero.unbudgeted > 0 ? (
              <>
                {" · "}
                {t("dashboard.outsidePlan")} <Ltr>{formatMinor(hero.unbudgeted, home)}</Ltr>
              </>
            ) : null}
          </p>
        </>
      ) : (
        <>
          <div className="hero-bar ghost" />
          <p className="hero-note">
            <Link to={`/budget?period=month&month=${period}`}>{t("dashboard.setLimit")}</Link>
          </p>
        </>
      )}

      <dl className="stat-cards">
        <div className="stat-card">
          <dt>{t("dashboard.income")}</dt>
          <dd>
            <Ltr>{formatMinor(homeTotals.income, home)}</Ltr>
          </dd>
        </div>
        <div className="stat-card">
          <dt>{t("dashboard.net")}</dt>
          <dd className={net > 0 ? "pos" : net < 0 ? "neg" : undefined}>
            <Ltr>{formatMinor(net, home)}</Ltr>
          </dd>
        </div>
      </dl>

      {categories.length > 0 ? (
        <>
          <h2 className="section-label">{t("dashboard.topCategories")}</h2>
          <ul className="cat-list group">
            {categories.map((child, index) => (
              <li key={child.id}>
                <Link
                  className="cat-row"
                  to={`/stats?month=${period}&currency=${home}&account=${child.id}`}
                >
                  <span className={`swatch cat-${index % 6}`} />
                  <span>{child.name}</span>
                  <span className="amount">
                    <Ltr>{formatMinor(child.amount, home)}</Ltr>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {otherCurrencies.map(([currency, figures]) => (
        <section key={currency}>
          <h2 className="section-label">{currencySymbol(currency)}</h2>
          <dl className="detail-list">
            <div>
              <dt>{t("dashboard.income")}</dt>
              <dd>
                <Ltr>{formatMinor(figures.income, currency)}</Ltr>
              </dd>
            </div>
            <div>
              <dt>{t("dashboard.expenses")}</dt>
              <dd>
                <Link className="stats-link" to={`/stats?month=${period}&currency=${currency}`}>
                  <Ltr>{formatMinor(figures.expense, currency)}</Ltr>
                </Link>
              </dd>
            </div>
          </dl>
        </section>
      ))}

      {overCount > 0 ? (
        <p className="hero-note over">
          <Link to={budgetHref}>{t("dashboard.budgetOver", { count: overCount })}</Link>
        </p>
      ) : null}
    </main>
  );
}
