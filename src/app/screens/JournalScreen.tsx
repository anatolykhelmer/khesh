import type { ReactNode } from "react";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { JournalEntry } from "../../kernel";
import { inferEntryLines } from "../../service/ledger-app";
import { currentYearMonth, formatYearMonth, shiftYearMonth, todayCalendarDate } from "../../service/dates";
import type { YearMonth } from "../../service/dates";
import { AccountPicker } from "../components/AccountPicker";
import { ChevronBack, ChevronForward, ArrowForward } from "../components/icons";
import { Ltr } from "../components/Ltr";
import { accountPathLabel, formatDate, formatMinor, monthLabel } from "../format";
import { isDefaultFilter, parseJournalFilter, toListJournalFilter } from "../journal-filter";
import { journalRows } from "../journal-rows";
import { useLedger } from "../ledger-context";

export function JournalScreen() {
  const { t } = useTranslation();
  const { book, app } = useLedger();
  const [params, setParams] = useSearchParams();

  const filter = useMemo(() => (book ? parseJournalFilter(params, book) : null), [book, params]);
  const nodes = useMemo(() => {
    if (!book) return [];
    const tree = app.accountTree(book);
    return tree.ok ? tree.value : [];
  }, [book, app]);
  // Pending rows are due today, independent of the journal's own month/account filter —
  // journalRows below re-filters them through the same predicate the confirmed entries use.
  const due = useMemo(
    () => (book ? app.dueRows(book, todayCalendarDate()) : []),
    [book, app],
  );

  if (!book || !filter) return null;

  const currentBook = book;
  const currentFilter = filter;

  function writeParams(next: URLSearchParams) {
    setParams(next);
  }

  function setPeriod(period: YearMonth | null) {
    const draft = new URLSearchParams(params);
    draft.set("month", period === null ? "all" : formatYearMonth(period));
    writeParams(draft);
  }

  function setAccount(id: string) {
    const draft = new URLSearchParams(params);
    if (id === "") draft.delete("account");
    else draft.set("account", id);
    writeParams(draft);
  }

  // Stepping while in all-time mode returns to month mode, starting from today.
  function step(delta: number) {
    setPeriod(shiftYearMonth(currentFilter.period ?? currentYearMonth(), delta));
  }

  const listFilter = toListJournalFilter(currentFilter);
  const listed = app.listJournal(currentBook, listFilter);
  if (!listed.ok) {
    return (
      <main className="screen">
        <h1>{t("journal.title")}</h1>
        <p className="muted">{t("journal.couldNotLoad")}</p>
      </main>
    );
  }

  const entries = listed.value;
  const rows = journalRows(entries, due, currentBook, listFilter);
  const currencyOf = (accountId: string) =>
    currentBook.accounts.find((a) => a.id === accountId)?.currency ?? currentBook.homeCurrency;

  function entryDisplay(entry: JournalEntry): { title: string; subtitle: ReactNode; amount: string } {
    const shape = inferEntryLines(entry);
    const title =
      entry.kind === "opening"
        ? entry.description || t("journal.openingBalance")
        : entry.description || t("journal.transfer");
    let subtitle: ReactNode = null;
    if (shape) {
      const fromPath = accountPathLabel(currentBook, shape.fromAccountId);
      const toPath = accountPathLabel(currentBook, shape.lines[0].toAccountId);
      if (shape.fx) {
        subtitle = (
          <>
            {fromPath} <span className="flow-arrow"><ArrowForward /></span> {toPath} ·{" "}
            <Ltr>{formatMinor(shape.fromAmount, shape.fx.baseCurrency)}</Ltr>
          </>
        );
      } else if (shape.lines.length === 1) {
        subtitle = (
          <>
            {fromPath} <span className="flow-arrow"><ArrowForward /></span> {toPath}
          </>
        );
      } else {
        subtitle = (
          <>
            {fromPath}{" "}
            <span className="flow-arrow"><ArrowForward /></span>{" "}
            {t("journal.categoriesCount", { count: shape.lines.length })}
          </>
        );
      }
    } else if (entry.kind === "opening") {
      subtitle = t("journal.opening");
    }
    const amount = shape
      ? formatMinor(shape.total, currencyOf(shape.lines[0].toAccountId))
      : entry.postings[0]
        ? formatMinor(entry.postings[0].amount, currencyOf(entry.postings[0].accountId))
        : "";
    return { title, subtitle, amount };
  }

  return (
    <main className="screen">
      <h1>{t("journal.title")}</h1>

      <div className="month-nav">
        <button
          type="button"
          className="twisty"
          aria-label={t("common.previousMonth")}
          onClick={() => step(-1)}
        >
          <ChevronBack />
        </button>
        <span>
          {currentFilter.period
            ? `${monthLabel(currentFilter.period.month)} ${currentFilter.period.year}`
            : t("journal.allTime")}
        </span>
        <button type="button" className="twisty" aria-label={t("common.nextMonth")} onClick={() => step(1)}>
          <ChevronForward />
        </button>
      </div>

      <div className="filter-bar">
        <button
          type="button"
          className="secondary"
          onClick={() => setPeriod(currentFilter.period ? null : currentYearMonth())}
        >
          {currentFilter.period ? t("journal.allTime") : t("journal.thisMonth")}
        </button>
        <AccountPicker
          nodes={nodes}
          value={currentFilter.accountId}
          onChange={(id) => setAccount(id ?? "")}
          label={t("journal.filterByAccount")}
          groupsSelectable
          allOptionLabel={t("journal.allAccounts")}
          placeholder={t("journal.allAccounts")}
        />
        {isDefaultFilter(currentFilter) ? null : (
          <button
            type="button"
            className="secondary"
            onClick={() => writeParams(new URLSearchParams())}
          >
            {t("journal.reset")}
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="muted">
          {currentBook.journal.length === 0 ? t("journal.noEntriesYet") : t("journal.noEntriesMatch")}
        </p>
      ) : (
        <ul className="journal-list group">
          {rows.map((row) => {
            const pending = row.kind === "pending";
            const entry = row.kind === "pending" ? row.due.preview : row.entry;
            const key = row.kind === "pending" ? row.due.entryId : row.entry.id;
            const to =
              row.kind === "pending"
                ? `/recurring/${row.due.ruleId}/post/${row.due.date}`
                : `/journal/${row.entry.id}`;
            const { title, subtitle, amount } = entryDisplay(entry);
            return (
              <li key={key}>
                <Link className={pending ? "journal-row pending" : "journal-row"} to={to}>
                  <div>
                    <div className="journal-title">
                      {title}
                      {pending ? <span className="badge">{t("recurring.pending")}</span> : null}
                    </div>
                    {subtitle ? <div className="muted">{subtitle}</div> : null}
                    <div className="muted">{formatDate(entry.date)}</div>
                  </div>
                  <div className="journal-amount">
                    <Ltr>{amount}</Ltr>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
