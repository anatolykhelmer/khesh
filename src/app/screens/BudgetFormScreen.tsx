import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { BudgetPeriod, CurrencyCode } from "../../kernel";
import { errorMessage } from "../../service/error-messages";
import { majorToMinor } from "../../service/money";
import { parseBudgetState, setPeriodKind, toBudgetParams } from "../budget-state";
import { AccountPicker } from "../components/AccountPicker";
import { CURRENCIES } from "../currencies";
import { useLedger } from "../ledger-context";

export function BudgetFormScreen() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { book, app, setBook, setError } = useLedger();

  // The period the user was viewing on /budget, carried in the URL so leaving this
  // screen returns them to it rather than to the current month.
  const viewed = parseBudgetState(searchParams);

  const [accountId, setAccountId] = useState<string | null>(null);
  const [period, setPeriod] = useState<BudgetPeriod>(viewed.period);
  const [currency, setCurrency] = useState<CurrencyCode>(book?.homeCurrency ?? "ILS");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const nodes = useMemo(() => {
    if (!book) return [];
    const tree = app.accountTree(book);
    return tree.ok ? tree.value.filter((node) => node.type === "expense") : [];
  }, [book, app]);

  if (!book) return null;

  const currentBook = book;
  const replaces = currentBook.budgets.some(
    (budget) =>
      budget.accountId === accountId &&
      budget.period === period &&
      budget.currency === currency,
  );

  function chooseAccount(id: string | null) {
    setAccountId(id);
    const account = id ? currentBook.accounts.find((a) => a.id === id) : undefined;
    // A leaf can only be spent in its own currency, so default to it; a group may
    // hold several, so the home currency stays the starting point there.
    if (account && !account.isPlaceholder) setCurrency(account.currency);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!accountId) return;
    const limit = majorToMinor(amount);
    if (limit === null || limit <= 0) {
      setError(errorMessage("BUDGET_LIMIT_INVALID"));
      return;
    }
    setBusy(true);
    const result = await app.setBudget(currentBook, { accountId, period, currency, limit });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result.error.code));
      return;
    }
    setError(null);
    setBook(result.value);
    // Land on the period the new limit belongs to — showing the month view after
    // creating an annual limit would land on a screen the limit isn't on.
    navigate(`/budget?${toBudgetParams(setPeriodKind(viewed, period)).toString()}`);
  }

  return (
    <main className="screen">
      <h1>{t("budgetForm.newTitle")}</h1>
      <form className="stack-form" onSubmit={onSubmit}>
        {/* Not a <label>: <button> is labelable, so a label wrapper forwards clicks
            inside the open picker dialog back to the trigger — see BL-007. */}
        <div className="stack-form-field">
          {t("budgetForm.categoryLabel")}
          <AccountPicker
            nodes={nodes}
            value={accountId}
            onChange={chooseAccount}
            label={t("budgetForm.categoryLabel")}
            groupsSelectable
            placeholder={t("budgetForm.categoryPlaceholder")}
          />
        </div>
        <fieldset className="choice-group">
          <legend>{t("budgetForm.periodLabel")}</legend>
          <label className="inline-choice">
            <input
              type="radio"
              name="period"
              checked={period === "month"}
              onChange={() => setPeriod("month")}
            />
            {t("budget.periodMonth")}
          </label>
          <label className="inline-choice">
            <input
              type="radio"
              name="period"
              checked={period === "year"}
              onChange={() => setPeriod("year")}
            />
            {t("budget.periodYear")}
          </label>
        </fieldset>
        <label>
          {t("budgetForm.currencyLabel")}
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
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
        {replaces ? <p className="muted">{t("budgetForm.replacesExisting")}</p> : null}
        <button type="submit" className="primary" disabled={busy || !accountId || !amount.trim()}>
          {t("budgetForm.save")}
        </button>
      </form>
      <Link className="back-link" to={`/budget?${toBudgetParams(viewed).toString()}`}>
        {t("budgetForm.backToBudget")}
      </Link>
    </main>
  );
}
