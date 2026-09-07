import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { RecurrenceUnit } from "../../kernel";
import { todayCalendarDate } from "../../service/dates";
import { errorMessage } from "../../service/error-messages";
import { majorToMinor, minorToMajor } from "../../service/money";
import { AccountPicker } from "../components/AccountPicker";
import { XMark } from "../components/icons";
import { useLedger } from "../ledger-context";
import { nextOccurrence } from "../recurring-state";
import { useLedgerMutation } from "../use-ledger-mutation";

type LineDraft = { toAccountId: string; amount: string };

const EMPTY_LINE: LineDraft = { toAccountId: "", amount: "" };

export function RecurringFormScreen() {
  const { t } = useTranslation();
  const { ruleId } = useParams<{ ruleId?: string }>();
  const navigate = useNavigate();
  const { book, app, setError } = useLedger();
  const { busy, run } = useLedgerMutation();

  const rule = book && ruleId ? book.recurrences.find((r) => r.id === ruleId) : undefined;

  const [description, setDescription] = useState(rule?.description ?? "");
  const [fromAccountId, setFromAccountId] = useState(rule?.fromAccountId ?? "");
  const [lines, setLines] = useState<LineDraft[]>(
    rule
      ? rule.lines.map((line) => ({ toAccountId: line.toAccountId, amount: minorToMajor(line.amount) }))
      : [EMPTY_LINE],
  );
  const [every, setEvery] = useState(String(rule?.every ?? 1));
  const [unit, setUnit] = useState<RecurrenceUnit>(rule?.unit ?? "month");
  const [startDate, setStartDate] = useState(rule?.startDate ?? todayCalendarDate());
  const [endDate, setEndDate] = useState(rule?.endDate ?? "");
  const [startShifted, setStartShifted] = useState(false);

  const nodes = useMemo(() => {
    if (!book) return [];
    const tree = app.accountTree(book);
    return tree.ok ? tree.value : [];
  }, [book, app]);

  if (!book) return null;
  const currentBook = book;

  // Reachable when the rule was deleted on another device while this screen was open.
  if (ruleId && !rule) {
    return (
      <main className="screen">
        <h1>{t("recurring.titleEdit")}</h1>
        <p className="muted">{errorMessage("RECURRENCE_NOT_FOUND")}</p>
      </main>
    );
  }
  const editing = rule;

  function setLine(index: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  /**
   * Every occurrence id is built from the schedule, so changing it on a live rule would
   * offer dates that were already paid. Move the start to the next future occurrence —
   * unless the user has already chosen a start of their own, in which case they mean it.
   */
  function changeSchedule(next: { every?: string; unit?: RecurrenceUnit }) {
    const nextEvery = next.every ?? every;
    const nextUnit = next.unit ?? unit;
    setEvery(nextEvery);
    setUnit(nextUnit);
    // `startShifted` is what separates "this screen moved the date" from "the user
    // moved it". Testing the date against the rule's own start alone would not: the
    // shift below falsifies that comparison, so the guard would fire once per edit
    // session and then silently stop recomputing on every later schedule change.
    if (!editing || (!startShifted && startDate !== editing.startDate)) return;
    const parsedEvery = Number(nextEvery);
    const upcoming = nextOccurrence(
      {
        ...editing,
        every: Number.isInteger(parsedEvery) && parsedEvery >= 1 ? parsedEvery : editing.every,
        unit: nextUnit,
      },
      todayCalendarDate(),
    );
    setStartDate(upcoming ?? todayCalendarDate());
    setStartShifted(true);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed: Array<{ toAccountId: string; amount: number }> = [];
    for (const line of lines) {
      const minor = majorToMinor(line.amount);
      if (minor === null || minor <= 0) {
        setError(errorMessage("ENTRY_AMOUNT_INVALID"));
        return;
      }
      if (!line.toAccountId) {
        setError(t("transferForm.errors.chooseAccounts"));
        return;
      }
      parsed.push({ toAccountId: line.toAccountId, amount: minor });
    }
    if (!fromAccountId) {
      setError(t("transferForm.errors.chooseAccounts"));
      return;
    }
    const everyNumber = Number(every);
    if (!Number.isInteger(everyNumber) || everyNumber < 1) {
      setError(errorMessage("RECURRENCE_SCHEDULE_INVALID"));
      return;
    }

    // Everything else — same account twice, a category, a currency clash — is the
    // kernel's to refuse; `run` turns its Result into the banner.
    const input = {
      description: description.trim(),
      fromAccountId,
      lines: parsed,
      every: everyNumber,
      unit,
      startDate,
      endDate: endDate === "" ? null : endDate,
    };
    await run(
      () =>
        editing
          ? app.updateRecurrence(currentBook, { ...input, id: editing.id })
          : app.addRecurrence(currentBook, input),
      () => navigate("/recurring"),
    );
  }

  return (
    <main className="screen">
      <h1>{editing ? t("recurring.titleEdit") : t("recurring.titleNew")}</h1>
      <form className="stack-form" onSubmit={onSubmit}>
        <div className="group form-group">
          <label>
            {t("recurring.descriptionLabel")}
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>

        <section>
          <h2 className="section-label">{t("recurring.fromLabel")}</h2>
          <div className="group form-group">
            <AccountPicker
              nodes={nodes}
              value={fromAccountId === "" ? null : fromAccountId}
              onChange={(id) => setFromAccountId(id ?? "")}
              label={t("recurring.fromLabel")}
              groupsSelectable={false}
              placeholder={t("transferForm.selectPlaceholder")}
            />
          </div>
        </section>

        <section>
          <h2 className="section-label">{t("recurring.toLabel")}</h2>
          <div className="group form-group" role="group" aria-label={t("recurring.toLabel")}>
            {lines.map((line, index) => (
              <div className="split-line" key={index}>
                <AccountPicker
                  nodes={nodes}
                  value={line.toAccountId === "" ? null : line.toAccountId}
                  onChange={(id) => setLine(index, { toAccountId: id ?? "" })}
                  label={t("transferForm.lineAccountAria", { index: index + 1 })}
                  groupsSelectable={false}
                  placeholder={t("transferForm.selectPlaceholder")}
                />
                <input
                  aria-label={t("transferForm.lineAmountAria", { index: index + 1 })}
                  inputMode="decimal"
                  dir="ltr"
                  placeholder="0.00"
                  value={line.amount}
                  onChange={(e) => setLine(index, { amount: e.target.value })}
                  required
                />
                {lines.length >= 2 ? (
                  <button
                    type="button"
                    className="secondary"
                    aria-label={t("recurring.removeLine")}
                    onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <XMark />
                  </button>
                ) : null}
              </div>
            ))}
            <button
              type="button"
              className="secondary"
              onClick={() => setLines((prev) => [...prev, EMPTY_LINE])}
            >
              {t("recurring.addLine")}
            </button>
          </div>
        </section>

        <section>
          <h2 className="section-label">{t("recurring.everyLabel")}</h2>
          <div className="group form-group">
            <div className="split-line">
              <input
                aria-label={t("recurring.everyLabel")}
                type="number"
                min={1}
                step={1}
                dir="ltr"
                value={every}
                onChange={(e) => changeSchedule({ every: e.target.value })}
                required
              />
              <select
                aria-label={t("recurring.unitLabel")}
                value={unit}
                onChange={(e) => changeSchedule({ unit: e.target.value as RecurrenceUnit })}
              >
                <option value="week">{t("recurring.unitWeek")}</option>
                <option value="month">{t("recurring.unitMonth")}</option>
                <option value="year">{t("recurring.unitYear")}</option>
              </select>
            </div>
            <label>
              {t("recurring.startLabel")}
              <input
                type="date"
                dir="ltr"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setStartShifted(false);
                }}
                required
              />
            </label>
            {startShifted ? <p className="muted">{t("recurring.scheduleChangedHint")}</p> : null}
            <label>
              {t("recurring.endLabel")}
              <input type="date" dir="ltr" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </label>
          </div>
        </section>

        <button type="submit" className="primary" disabled={busy}>
          {t("recurring.save")}
        </button>
        <Link className="secondary link-button" to="/recurring">
          {t("recurring.cancel")}
        </Link>
      </form>

      {editing ? (
        <div className="group form-group">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              run(() => app.setRecurrencePaused(currentBook, editing.id, editing.pausedAt === null))
            }
          >
            {editing.pausedAt === null ? t("recurring.pause") : t("recurring.resume")}
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() =>
              run(
                () => app.removeRecurrence(currentBook, editing.id),
                () => navigate("/recurring"),
              )
            }
          >
            {t("recurring.delete")}
          </button>
        </div>
      ) : null}
    </main>
  );
}
