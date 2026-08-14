import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { CurrencyCode } from "../../kernel";
import { errorMessage } from "../../service/error-messages";
import { majorToMinor } from "../../service/money";
import { CURRENCIES } from "../currencies";
import { useLedger } from "../ledger-context";

export function AccountFormScreen() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { book, app, setBook, setError } = useLedger();

  const options = useMemo(() => (book ? app.parentOptions(book) : []), [book, app]);
  const [parentId, setParentId] = useState(searchParams.get("parent") ?? "");
  const [name, setName] = useState("");
  const [isPlaceholder, setIsPlaceholder] = useState(false);
  const [currency, setCurrency] = useState<CurrencyCode>(book?.homeCurrency ?? "ILS");
  const [opening, setOpening] = useState("");
  const [busy, setBusy] = useState(false);

  if (!book) return null;

  const currentBook = book;
  const selectedParent = parentId || options[0]?.id || "";

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const openingMinor = opening.trim() === "" ? undefined : majorToMinor(opening);
    if (opening.trim() !== "" && openingMinor === null) {
      setError(errorMessage("ENTRY_AMOUNT_INVALID"));
      return;
    }
    setBusy(true);
    const result = await app.addAccount(currentBook, {
      parentId: selectedParent,
      name,
      isPlaceholder,
      currency,
      openingAmount:
        !isPlaceholder && openingMinor && openingMinor > 0 ? openingMinor : undefined,
    });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result.error.code));
      return;
    }
    setError(null);
    setBook(result.value);
    // An opening balance also creates the sys:ob accounts, so skip those when
    // looking for the account we just added.
    const known = new Set(currentBook.accounts.map((a) => a.id));
    const created = result.value.accounts.find(
      (a) => !known.has(a.id) && !a.id.startsWith("sys:"),
    );
    navigate(`/accounts/${created?.id ?? selectedParent}`);
  }

  return (
    <main className="screen">
      <h1>{t("accountForm.title")}</h1>
      <form className="stack-form" onSubmit={onSubmit}>
        <label>
          {t("accountForm.parentLabel")}
          <select
            value={selectedParent}
            onChange={(e) => setParentId(e.target.value)}
            required
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.path}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("accountForm.nameLabel")}
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <fieldset className="choice-group">
          <legend>{t("common.kind")}</legend>
          <label className="inline-choice">
            <input
              type="radio"
              name="kind"
              checked={!isPlaceholder}
              onChange={() => setIsPlaceholder(false)}
            />
            {t("common.choiceAccount")}
          </label>
          <label className="inline-choice">
            <input
              type="radio"
              name="kind"
              checked={isPlaceholder}
              onChange={() => setIsPlaceholder(true)}
            />
            {t("common.choiceGroup")}
          </label>
        </fieldset>
        {isPlaceholder ? null : (
          <>
            <label>
              {t("accountForm.currencyLabel")}
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("accountForm.openingBalanceLabel")}
              <input
                inputMode="decimal"
                dir="ltr"
                placeholder="0.00"
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
              />
            </label>
          </>
        )}
        <button
          type="submit"
          className="primary"
          disabled={busy || !name.trim() || !selectedParent}
        >
          {t("accountForm.saveAccount")}
        </button>
      </form>
      <Link className="back-link" to="/accounts">
        {t("common.backToAccounts")}
      </Link>
    </main>
  );
}
