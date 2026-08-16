import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { monthRange, shiftYearMonth } from "../../service/dates";
import { pieArcs } from "../expense-pie";
import { Ltr } from "../components/Ltr";
import { currencySymbol } from "../currencies";
import { formatMinor, monthLabel } from "../format";
import { useLedger } from "../ledger-context";
import { expenseRootId, parseStatsState, toStatsParams } from "../stats-state";

const PIE_COLORS = ["#18181b", "#3f3f46", "#52525b", "#71717a", "#a1a1aa", "#d4d4d8"];
const PIE = { cx: 100, cy: 100, r: 90 };

export function StatsScreen() {
  const { t } = useTranslation();
  const { book, app } = useLedger();
  const [params, setParams] = useSearchParams();

  if (!book) return null;

  const currentBook = book;
  const state = parseStatsState(params, currentBook);
  const accountId = state.accountId ?? expenseRootId(currentBook);

  function write(next: typeof state) {
    setParams(toStatsParams(next));
  }

  if (!accountId) {
    return (
      <main className="screen">
        <h1>{t("stats.title")}</h1>
        <p className="muted">{t("stats.couldNotLoad")}</p>
      </main>
    );
  }

  const range = monthRange(state.period.year, state.period.month);
  const result = app.periodBreakdown(
    currentBook,
    range,
    accountId,
    state.currency ?? undefined,
  );

  if (!result.ok) {
    return (
      <main className="screen">
        <h1>{t("stats.title")}</h1>
        <p className="muted">{t("stats.couldNotLoad")}</p>
      </main>
    );
  }

  const breakdown = result.value;
  const arcs = pieArcs(breakdown.children, PIE);
  const showPie = breakdown.isGroup && breakdown.children.length > 0 && breakdown.total > 0;

  return (
    <main className="screen">
      <h1>{t("stats.title")}</h1>
      <nav className="crumb" aria-label={t("stats.breadcrumbLabel")}>
        {breakdown.ancestors.map((node, index) => (
          <span key={node.id}>
            {index > 0 ? " › " : null}
            <Link
              to={`/stats?${toStatsParams({
                period: state.period,
                accountId: index === 0 ? null : node.id,
                currency: state.currency,
              }).toString()}`}
            >
              {node.name}
            </Link>
          </span>
        ))}
        {breakdown.ancestors.length > 0 ? " › " : null}
        <span>{breakdown.name}</span>
      </nav>
      <div className="month-nav">
        <button
          type="button"
          className="twisty"
          aria-label={t("common.previousMonth")}
          onClick={() => write({ ...state, period: shiftYearMonth(state.period, -1) })}
        >
          ◂
        </button>
        <span>
          {monthLabel(state.period.month)} {state.period.year}
        </span>
        <button
          type="button"
          className="twisty"
          aria-label={t("common.nextMonth")}
          onClick={() => write({ ...state, period: shiftYearMonth(state.period, 1) })}
        >
          ▸
        </button>
      </div>
      {breakdown.currencies.length > 1 ? (
        <div className="pills">
          {breakdown.currencies.map((code) => (
            <button
              key={code}
              type="button"
              className={code === breakdown.currency ? "pill on" : "pill"}
              onClick={() => write({ ...state, currency: code })}
            >
              {currencySymbol(code)}
            </button>
          ))}
        </div>
      ) : null}
      {showPie ? (
        <>
          <p className="stats-total">
            <Ltr>{formatMinor(breakdown.total, breakdown.currency)}</Ltr>
          </p>
          <svg className="stats-pie" viewBox="0 0 200 200" aria-hidden="true">
            {arcs.map((arc, index) => (
              <path
                key={arc.id}
                d={arc.d}
                fill={PIE_COLORS[index % PIE_COLORS.length]}
                onClick={() => write({ ...state, accountId: arc.id })}
              />
            ))}
          </svg>
          <ul className="stats-legend">
            {breakdown.children.map((child, index) => (
              <li key={child.id}>
                <button
                  type="button"
                  className="stats-row"
                  aria-label={t("stats.rowLabel", {
                    name: child.name,
                    amount: formatMinor(child.amount, breakdown.currency),
                  })}
                  onClick={() => write({ ...state, accountId: child.id })}
                >
                  <span className="swatch" style={{ background: PIE_COLORS[index % PIE_COLORS.length] }} />
                  <span>{child.name}</span>
                  <span className="muted">
                    <Ltr>{formatMinor(child.amount, breakdown.currency)}</Ltr>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : breakdown.total > 0 ? (
        <p className="stats-total">
          <Ltr>{formatMinor(breakdown.total, breakdown.currency)}</Ltr>
        </p>
      ) : (
        <p className="muted">{t("stats.empty")}</p>
      )}
    </main>
  );
}
