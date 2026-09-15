import type { FormEvent } from "react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../service/error-messages";
import { majorToMinor, minorToMajor } from "../../service/money";
import { todayCalendarDate } from "../../service/dates";
import { ChevronBack } from "../components/icons";
import { useLedger } from "../ledger-context";
import { useLedgerMutation } from "../use-ledger-mutation";
import { accountPathLabel } from "../format";
import { currencySymbol } from "../currencies";

export function OpeningBalanceFormScreen() {
  const { t } = useTranslation();
  const { accountId } = useParams<{ accountId: string }>();
  const navigate = useNavigate();
  const { book, app, setError } = useLedger();
  const { busy, run } = useLedgerMutation();

  const account = book?.accounts.find((a) => a.id === accountId);
  const existing = book && account ? app.openingBalanceOf(book, account.id) : undefined;

  const [date, setDate] = useState(existing?.date ?? todayCalendarDate());
  const [amount, setAmount] = useState(existing ? minorToMajor(existing.amount) : "");

  if (!book || !accountId) return null;

  const currentBook = book;

  if (!account || account.isPlaceholder || account.id.startsWith("sys:")) {
    return (
      <main className="screen">
        <div className="screen-head">
          <Link
            className="icon-button back-button"
            to={`/accounts/${accountId}`}
            aria-label={t("openingBalanceForm.backToAccount")}
          >
            <ChevronBack />
          </Link>
          <h1>{t("openingBalanceForm.title")}</h1>
        </div>
        <p className="muted">{t("openingBalanceForm.notAvailable")}</p>
      </main>
    );
  }

  const currentAccount = account;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const minor = amount.trim() === "" ? 0 : majorToMinor(amount);
    if (minor === null) {
      setError(errorMessage("ENTRY_AMOUNT_INVALID"));
      return;
    }
    await run(
      () =>
        app.setOpeningBalance(currentBook, { accountId: currentAccount.id, amount: minor, date }),
      () => navigate(`/accounts/${currentAccount.id}`),
    );
  }

  return (
    <main className="screen">
      <div className="screen-head">
        <Link
          className="icon-button back-button"
          to={`/accounts/${currentAccount.id}`}
          aria-label={t("openingBalanceForm.backToAccount")}
        >
          <ChevronBack />
        </Link>
        <h1>{t("openingBalanceForm.title")}</h1>
      </div>
      <p className="muted">{accountPathLabel(currentBook, currentAccount.id)}</p>
      <form className="stack-form" onSubmit={onSubmit}>
        <div className="group form-group">
          <label>
            {t("openingBalanceForm.dateLabel")}
            <input
              type="date"
              dir="ltr"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </label>
          <label>
            {t("openingBalanceForm.amountLabel")} ({currencySymbol(currentAccount.currency)})
            <input
              inputMode="decimal"
              dir="ltr"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          {existing ? <p className="muted">{t("openingBalanceForm.clearHint")}</p> : null}
        </div>
        <button type="submit" className="primary" disabled={busy}>
          {t("openingBalanceForm.save")}
        </button>
      </form>
    </main>
  );
}
