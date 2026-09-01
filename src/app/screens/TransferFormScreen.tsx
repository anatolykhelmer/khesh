import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { EntryLine } from "../../service/ledger-app";
import { inferEntryLines } from "../../service/ledger-app";
import { todayCalendarDate } from "../../service/dates";
import { errorMessage } from "../../service/error-messages";
import { majorToMinor, minorToMajor } from "../../service/money";
import { Ltr } from "../components/Ltr";
import { XMark } from "../components/icons";
import { formatMinor, formatRate } from "../format";
import { useLedger } from "../ledger-context";
import { useLedgerMutation } from "../use-ledger-mutation";
import { AccountPicker } from "../components/AccountPicker";

type LineDraft = { toAccountId: string; amount: string };

const EMPTY_LINE: LineDraft = { toAccountId: "", amount: "" };

export function TransferFormScreen() {
  const { t } = useTranslation();
  const { entryId } = useParams<{ entryId?: string }>();
  const navigate = useNavigate();
  const { book, app, setError } = useLedger();
  const { busy, run } = useLedgerMutation();

  const existing = book && entryId ? book.journal.find((e) => e.id === entryId) : undefined;
  const existingShape = existing ? inferEntryLines(existing) : null;

  const [date, setDate] = useState(existing?.date ?? todayCalendarDate());
  const [description, setDescription] = useState(existing?.description ?? "");
  const [fromAccountId, setFromAccountId] = useState(existingShape?.fromAccountId ?? "");
  const [lines, setLines] = useState<LineDraft[]>(
    existingShape
      ? existingShape.lines.map((line) => ({
          toAccountId: line.toAccountId,
          amount: minorToMajor(line.amount),
        }))
      : [EMPTY_LINE],
  );
  const [fromAmount, setFromAmount] = useState(
    existingShape && existingShape.fromAmount !== existingShape.total
      ? minorToMajor(existingShape.fromAmount)
      : "",
  );

  const nodes = useMemo(() => {
    if (!book) return [];
    const tree = app.accountTree(book);
    return tree.ok ? tree.value : [];
  }, [book, app]);

  const leafCount = useMemo(
    () =>
      book
        ? book.accounts.filter((a) => !a.isPlaceholder && !a.id.startsWith("sys:")).length
        : 0,
    [book],
  );

  if (!book) return null;

  const currentBook = book;

  if (entryId && existing && (existing.kind !== "standard" || !existingShape)) {
    return (
      <main className="screen">
        <h1>{t("transferForm.titleEdit")}</h1>
        <p className="muted">{t("transferForm.onlyStandardEditable")}</p>
      </main>
    );
  }

  const currencyOf = (id: string) => currentBook.accounts.find((a) => a.id === id)?.currency;
  const sourceCurrency = currencyOf(fromAccountId);
  const lineCurrencies = [
    ...new Set(
      lines
        .map((l) => currencyOf(l.toAccountId))
        .filter((c): c is string => c !== undefined),
    ),
  ];
  const lineCurrency = lineCurrencies.length === 1 ? lineCurrencies[0] : undefined;
  const mixedLines = lineCurrencies.length > 1;
  const isFx =
    sourceCurrency !== undefined && lineCurrency !== undefined && sourceCurrency !== lineCurrency;

  function setLine(index: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  function addLine() {
    setLines((prev) => [...prev, EMPTY_LINE]);
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  function chooseFrom(id: string) {
    setFromAccountId(id);
    const nextSource = currencyOf(id);
    const first = lines[0] ? currencyOf(lines[0].toAccountId) : undefined;
    if (
      lines.length > 1 &&
      nextSource !== undefined &&
      first !== undefined &&
      nextSource !== first
    ) {
      setLines((prev) => prev.slice(0, 1));
    }
  }

  const totalMinor = lines.reduce((sum, line) => sum + (majorToMinor(line.amount) ?? 0), 0);
  const fromMinor = majorToMinor(fromAmount);
  const fxPreview =
    isFx && fromMinor !== null && fromMinor > 0 && totalMinor > 0 && sourceCurrency && lineCurrency
      ? {
          baseCurrency: sourceCurrency,
          baseAmount: fromMinor,
          quoteCurrency: lineCurrency,
          quoteAmount: totalMinor,
        }
      : null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed: EntryLine[] = [];
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
    if (parsed.some((line) => line.toAccountId === fromAccountId)) {
      setError(errorMessage("ENTRY_TOO_FEW_ACCOUNTS"));
      return;
    }
    if (new Set(parsed.map((line) => line.toAccountId)).size !== parsed.length) {
      setError(t("transferForm.errors.duplicateAccount"));
      return;
    }
    if (!date) {
      setError(errorMessage("ENTRY_DATE_INVALID"));
      return;
    }
    if (mixedLines) {
      setError(t("transferForm.mixedCurrencies"));
      return;
    }
    let fromMinorParsed: number | undefined;
    if (isFx) {
      const parsedFrom = majorToMinor(fromAmount);
      if (parsedFrom === null || parsedFrom <= 0) {
        setError(t("transferForm.errors.enterSentAmount"));
        return;
      }
      if (parsed.length !== 1) {
        setError(errorMessage("ENTRY_FX_CURRENCY_COUNT"));
        return;
      }
      fromMinorParsed = parsedFrom;
    }

    const input = {
      date,
      description: description.trim(),
      fromAccountId,
      fromAmount: fromMinorParsed,
      lines: parsed,
    };

    await run(
      () =>
        entryId
          ? app.updateEntry(currentBook, entryId, input)
          : app.addEntry(currentBook, input),
      () => navigate("/journal"),
    );
  }

  const canSubmit = leafCount >= 2;

  return (
    <main className="screen">
      <h1>{entryId ? t("transferForm.titleEdit") : t("transferForm.titleNew")}</h1>
      {!canSubmit ? <p className="muted">{t("transferForm.notEnoughAccounts")}</p> : null}
      <form className="stack-form" onSubmit={onSubmit}>
        <div className="group form-group">
          <label>
            {t("transferForm.dateLabel")}
            <input
              type="date"
              dir="ltr"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </label>
          <label>
            {t("transferForm.descriptionLabel")}
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>

        <section>
          <h2 className="section-label">{t("transferForm.fromLabel")}</h2>
          <div className="group form-group">
            <div className="stack-form-field">
              <AccountPicker
                nodes={nodes}
                value={fromAccountId === "" ? null : fromAccountId}
                onChange={(id) => chooseFrom(id ?? "")}
                label={t("transferForm.fromAccountAria")}
                groupsSelectable={false}
                placeholder={t("transferForm.selectPlaceholder")}
              />
            </div>
            {isFx ? (
              <label>
                {t("transferForm.sentLabel", { currency: sourceCurrency })}
                <input
                  inputMode="decimal"
                  dir="ltr"
                  placeholder="0.00"
                  value={fromAmount}
                  onChange={(e) => setFromAmount(e.target.value)}
                  required
                />
              </label>
            ) : null}
          </div>
        </section>

        <section>
          <h2 className="section-label">{t("transferForm.toLegend")}</h2>
          <div className="group form-group">
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
                  aria-label={
                    isFx
                      ? t("transferForm.receivedAria", { currency: lineCurrency })
                      : t("transferForm.lineAmountAria", { index: index + 1 })
                  }
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
                    aria-label={t("transferForm.removeLineAria", { index: index + 1 })}
                    onClick={() => removeLine(index)}
                  >
                    <XMark />
                  </button>
                ) : null}
              </div>
            ))}
            {isFx ? null : (
              <button type="button" className="secondary" onClick={addLine}>
                {t("transferForm.addSplit")}
              </button>
            )}
            {mixedLines ? <div className="muted">{t("transferForm.mixedCurrencies")}</div> : null}
            {isFx && fxPreview ? (
              <div className="muted">
                {t("transferForm.ratePrefix")} <Ltr>{formatRate(fxPreview)}</Ltr>
              </div>
            ) : null}
            {!isFx && lines.length >= 2 && lineCurrency ? (
              <div className="muted">
                {t("transferForm.totalPrefix")} <Ltr>{formatMinor(totalMinor, lineCurrency)}</Ltr>
              </div>
            ) : null}
          </div>
        </section>

        <button type="submit" className="primary" disabled={busy || !canSubmit}>
          {t("transferForm.save")}
        </button>
      </form>
    </main>
  );
}
