import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../service/error-messages";
import { accountPathLabel, formatAccountBalance } from "../format";
import { currencySymbol } from "../currencies";
import { AccountKindChoice } from "../components/AccountKindChoice";
import { Ltr } from "../components/Ltr";
import { useLedger } from "../ledger-context";

export function AccountDetailScreen() {
  const { t } = useTranslation();
  const { accountId } = useParams<{ accountId: string }>();
  const navigate = useNavigate();
  const { book, app, setBook, setError } = useLedger();

  const account = book?.accounts.find((a) => a.id === accountId);
  const moveOptions = useMemo(
    () => (book && account ? app.parentOptions(book, { forAccountId: account.id }) : []),
    [book, account, app],
  );

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [isPlaceholder, setIsPlaceholder] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!book || !accountId) return null;

  const currentBook = book;
  if (!account) {
    return (
      <main className="screen">
        <h1>{t("accountDetail.titleFallback")}</h1>
        <p className="muted">{t("accountDetail.notFound")}</p>
        <Link className="back-link" to="/accounts">
          {t("common.backToAccounts")}
        </Link>
      </main>
    );
  }

  const currentAccount = account;
  const isRoot = currentAccount.parentId === null;
  const childCount = currentBook.accounts.filter((a) => a.parentId === currentAccount.id).length;

  function startEditing() {
    setName(currentAccount.name);
    setParentId(currentAccount.parentId ?? "");
    setIsPlaceholder(currentAccount.isPlaceholder);
    setEditing(true);
  }

  function balanceLabel(): string {
    const result = app.balanceOf(currentBook, currentAccount.id);
    if (!result.ok) return "—";
    return formatAccountBalance(result.value, currentBook.homeCurrency);
  }

  async function onSave(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await app.editAccount(currentBook, {
      id: currentAccount.id,
      name,
      parentId: isRoot ? undefined : parentId,
      isPlaceholder: isRoot ? undefined : isPlaceholder,
    });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result.error.code));
      return;
    }
    setError(null);
    setBook(result.value);
    setEditing(false);
  }

  async function onDelete() {
    if (!confirm(t("accountDetail.deleteConfirm", { name: currentAccount.name }))) return;
    setBusy(true);
    const result = await app.removeAccount(currentBook, currentAccount.id);
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result.error.code));
      return;
    }
    setError(null);
    setBook(result.value);
    navigate("/accounts");
  }

  return (
    <main className="screen">
      <h1>{currentAccount.name}</h1>
      <p className="muted">{accountPathLabel(currentBook, currentAccount.id)}</p>
      <dl className="detail-list">
        <div>
          <dt>{t("accountDetail.kindLabel")}</dt>
          <dd>
            {currentAccount.isPlaceholder
              ? t("accountDetail.kindGroup")
              : t("accountDetail.kindAccount")}
          </dd>
        </div>
        {currentAccount.isPlaceholder ? null : (
          <div>
            <dt>{t("accountDetail.currencyLabel")}</dt>
            <dd>{currencySymbol(currentAccount.currency)}</dd>
          </div>
        )}
        <div>
          <dt>{t("accountDetail.balanceLabel")}</dt>
          <dd>
            <Ltr>{balanceLabel()}</Ltr>
          </dd>
        </div>
        {currentAccount.isPlaceholder ? (
          <div>
            <dt>{t("accountDetail.nestedLabel")}</dt>
            <dd>{childCount}</dd>
          </div>
        ) : null}
      </dl>

      {editing ? (
        <form className="stack-form" onSubmit={onSave}>
          <label>
            {t("accountDetail.nameLabel")}
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          {isRoot ? (
            <p className="muted">{t("accountDetail.rootNotice")}</p>
          ) : (
            <>
              <label>
                {t("accountDetail.parentLabel")}
                <select value={parentId} onChange={(e) => setParentId(e.target.value)} required>
                  {moveOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.path}
                    </option>
                  ))}
                </select>
              </label>
              <AccountKindChoice value={isPlaceholder} onChange={setIsPlaceholder} />
            </>
          )}
          <button type="submit" className="primary" disabled={busy || !name.trim()}>
            {t("accountDetail.saveChanges")}
          </button>
          <button type="button" className="secondary" onClick={() => setEditing(false)}>
            {t("common.cancel")}
          </button>
        </form>
      ) : (
        <div className="button-row wrap">
          {currentAccount.isPlaceholder ? (
            <Link
              className="secondary link-button"
              to={`/accounts/new?parent=${currentAccount.id}`}
            >
              {t("accountDetail.addNested")}
            </Link>
          ) : null}
          <Link
            className="secondary link-button"
            to={`/journal?account=${currentAccount.id}&month=all`}
          >
            {t("accountDetail.entries")}
          </Link>
          <button type="button" className="secondary" onClick={startEditing}>
            {t("common.edit")}
          </button>
          {isRoot ? null : (
            <button type="button" className="danger" disabled={busy} onClick={onDelete}>
              {t("common.delete")}
            </button>
          )}
        </div>
      )}

      <Link className="back-link" to="/accounts">
        {t("common.backToAccounts")}
      </Link>
    </main>
  );
}
