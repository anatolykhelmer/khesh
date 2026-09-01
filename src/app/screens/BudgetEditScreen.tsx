import type { FormEvent } from "react";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../service/error-messages";
import { majorToMinor, minorToMajor } from "../../service/money";
import { parseBudgetState, toBudgetParams } from "../budget-state";
import { ChevronBack } from "../components/icons";
import { accountPathLabel } from "../format";
import { useLedger } from "../ledger-context";
import { useLedgerMutation } from "../use-ledger-mutation";

export function BudgetEditScreen() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { book, app, setError } = useLedger();
  const { busy, run } = useLedgerMutation();

  const accountId = searchParams.get("account") ?? "";
  const currency = searchParams.get("currency") ?? "";
  // The URL carries the period the user was viewing on /budget; a report only lists
  // budgets of its own period, so that same value is this budget's period too.
  const viewed = parseBudgetState(searchParams);
  const period = viewed.period;
  const backTo = `/budget?${toBudgetParams(viewed).toString()}`;

  const existing = book?.budgets.find(
    (budget) =>
      budget.accountId === accountId &&
      budget.period === period &&
      budget.currency === currency,
  );

  const [amount, setAmount] = useState(existing ? minorToMajor(existing.limit) : "");

  if (!book) return null;

  const currentBook = book;

  if (!existing) {
    return (
      <main className="screen">
        <div className="screen-head">
          <Link className="icon-button back-button" to={backTo} aria-label={t("budgetForm.backToBudget")}>
            <ChevronBack />
          </Link>
          <h1>{t("budgetForm.editTitle")}</h1>
        </div>
        <p className="muted">{t("budgetForm.notFound")}</p>
      </main>
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const limit = majorToMinor(amount);
    if (limit === null || limit <= 0) {
      setError(errorMessage("BUDGET_LIMIT_INVALID"));
      return;
    }
    await run(
      () => app.setBudget(currentBook, { accountId, period, currency, limit }),
      () => navigate(backTo),
    );
  }

  async function onDelete() {
    const name = accountPathLabel(currentBook, accountId);
    if (!confirm(t("budgetForm.deleteConfirm", { name }))) return;
    await run(
      () => app.removeBudget(currentBook, { accountId, period, currency }),
      () => navigate(backTo),
    );
  }

  return (
    <main className="screen">
      <div className="screen-head">
        <Link className="icon-button back-button" to={backTo} aria-label={t("budgetForm.backToBudget")}>
          <ChevronBack />
        </Link>
        <h1>{t("budgetForm.editTitle")}</h1>
      </div>
      <dl className="detail-list">
        <div>
          <dt>{t("budgetForm.categoryLabel")}</dt>
          <dd>{accountPathLabel(currentBook, accountId)}</dd>
        </div>
        <div>
          <dt>{t("budgetForm.periodLabel")}</dt>
          <dd>{period === "year" ? t("budget.periodYear") : t("budget.periodMonth")}</dd>
        </div>
        <div>
          <dt>{t("budgetForm.currencyLabel")}</dt>
          <dd>{currency}</dd>
        </div>
      </dl>
      <form className="stack-form" onSubmit={onSubmit}>
        <div className="group form-group">
          <label>
            {t("budgetForm.amountLabel")}
            <input
              inputMode="decimal"
              dir="ltr"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </label>
        </div>
        <button type="submit" className="primary" disabled={busy || !amount.trim()}>
          {t("budgetForm.save")}
        </button>
      </form>
      <div className="button-row">
        <button type="button" className="danger" disabled={busy} onClick={onDelete}>
          {t("budgetForm.deleteLimit")}
        </button>
      </div>
    </main>
  );
}
