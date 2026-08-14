import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { inferEntryLines } from "../../service/ledger-app";
import { errorMessage } from "../../service/error-messages";
import { Ltr } from "../components/Ltr";
import { accountPathLabel, formatDate, formatMinor, formatRate } from "../format";
import { useLedger } from "../ledger-context";

export function EntryDetailScreen() {
  const { t } = useTranslation();
  const { entryId } = useParams<{ entryId: string }>();
  const navigate = useNavigate();
  const { book, app, setBook, setError } = useLedger();
  const [busy, setBusy] = useState(false);

  if (!book || !entryId) return null;

  const currentBook = book;
  const entry = currentBook.journal.find((e) => e.id === entryId);
  if (!entry) {
    return (
      <main className="screen">
        <h1>{t("entryDetail.titleEntry")}</h1>
        <p className="muted">{t("entryDetail.notFound")}</p>
        <Link to="/journal">{t("entryDetail.backToJournal")}</Link>
      </main>
    );
  }

  const currentEntry = entry;
  const shape = inferEntryLines(currentEntry);
  const canEdit = currentEntry.kind === "standard" && shape !== null;
  const currencyOf = (accountId: string) =>
    currentBook.accounts.find((a) => a.id === accountId)?.currency ?? currentBook.homeCurrency;

  async function onDelete() {
    if (!confirm(t("entryDetail.deleteConfirm"))) return;
    setBusy(true);
    const result = await app.deleteEntry(currentBook, currentEntry.id);
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result.error.code));
      return;
    }
    setError(null);
    setBook(result.value);
    navigate("/journal");
  }

  return (
    <main className="screen">
      <h1>{currentEntry.kind === "opening" ? t("entryDetail.titleOpening") : t("entryDetail.titleEntry")}</h1>
      <dl className="detail-list">
        <div>
          <dt>{t("entryDetail.dateLabel")}</dt>
          <dd>
            <Ltr>{formatDate(currentEntry.date)}</Ltr>
          </dd>
        </div>
        <div>
          <dt>{t("entryDetail.descriptionLabel")}</dt>
          <dd>{currentEntry.description || "—"}</dd>
        </div>
        {shape ? (
          <>
            <div>
              <dt>{t("entryDetail.fromLabel")}</dt>
              <dd>
                {accountPathLabel(currentBook, shape.fromAccountId)}
                {shape.fx ? (
                  <>
                    {" — "}
                    <Ltr>{formatMinor(shape.fromAmount, shape.fx.baseCurrency)}</Ltr>
                  </>
                ) : null}
              </dd>
            </div>
            {shape.lines.map((line, index) => (
              <div key={line.toAccountId}>
                <dt>
                  {shape.lines.length === 1
                    ? t("entryDetail.toLabel")
                    : t("entryDetail.toLabelIndexed", { index: index + 1 })}
                </dt>
                <dd>
                  {accountPathLabel(currentBook, line.toAccountId)}
                  {shape.lines.length >= 2 || shape.fx ? (
                    <>
                      {" — "}
                      <Ltr>{formatMinor(line.amount, currencyOf(line.toAccountId))}</Ltr>
                    </>
                  ) : null}
                </dd>
              </div>
            ))}
            {shape.fx ? (
              <div>
                <dt>{t("entryDetail.rateLabel")}</dt>
                <dd>
                  <Ltr>{formatRate(shape.fx)}</Ltr>
                </dd>
              </div>
            ) : (
              <div>
                <dt>{shape.lines.length >= 2 ? t("entryDetail.totalLabel") : t("entryDetail.amountLabel")}</dt>
                <dd>
                  <Ltr>{formatMinor(shape.total, currencyOf(shape.lines[0].toAccountId))}</Ltr>
                </dd>
              </div>
            )}
          </>
        ) : (
          <div>
            <dt>{t("entryDetail.amountLabel")}</dt>
            <dd>
              {currentEntry.postings[0] ? (
                <Ltr>
                  {formatMinor(currentEntry.postings[0].amount, currencyOf(currentEntry.postings[0].accountId))}
                </Ltr>
              ) : (
                "—"
              )}
            </dd>
          </div>
        )}
      </dl>
      <div className="button-row">
        {canEdit ? (
          <Link className="secondary link-button" to={`/journal/${currentEntry.id}/edit`}>
            {t("common.edit")}
          </Link>
        ) : null}
        <button type="button" className="danger" disabled={busy} onClick={onDelete}>
          {t("common.delete")}
        </button>
      </div>
      <Link className="back-link" to="/journal">
        {t("entryDetail.backToJournal")}
      </Link>
    </main>
  );
}
