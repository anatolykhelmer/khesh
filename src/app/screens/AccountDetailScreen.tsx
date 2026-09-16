import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  accountPathLabel,
  formatAccountBalance,
  formatTurnoverField,
  type TurnoverField,
} from "../format";
import { currencySymbol } from "../currencies";
import { AccountKindChoice } from "../components/AccountKindChoice";
import { ChevronBack } from "../components/icons";
import { Ltr } from "../components/Ltr";
import { useLedger } from "../ledger-context";
import {
  SUMMARY_PRESETS,
  SUMMARY_PRESET_KEYS,
  isSummaryPreset,
  parseSummaryState,
  summaryBounds,
  summaryLabel,
  summaryMonthParam,
  toSummaryParams,
  type SummaryState,
} from "../period-summary";
import { useLedgerMutation } from "../use-ledger-mutation";

export function AccountDetailScreen() {
  const { t } = useTranslation();
  const { accountId } = useParams<{ accountId: string }>();
  const navigate = useNavigate();
  const { book, app } = useLedger();
  const { busy, run } = useLedgerMutation();
  const [params, setParams] = useSearchParams();
  const summary = useMemo(() => parseSummaryState(params), [params]);

  const account = book?.accounts.find((a) => a.id === accountId);
  const moveOptions = useMemo(
    () => (book && account ? app.parentOptions(book, { forAccountId: account.id }) : []),
    [book, account, app],
  );

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [isPlaceholder, setIsPlaceholder] = useState(false);

  if (!book || !accountId) return null;

  const currentBook = book;
  if (!account) {
    return (
      <main className="screen">
        <div className="screen-head">
          <Link className="icon-button back-button" to="/accounts" aria-label={t("common.backToAccounts")}>
            <ChevronBack />
          </Link>
          <h1>{t("accountDetail.titleFallback")}</h1>
        </div>
        <p className="muted">{t("accountDetail.notFound")}</p>
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

  const isCategory = currentAccount.type === "income" || currentAccount.type === "expense";

  function balanceLabel(): string {
    const result = app.balanceOf(currentBook, currentAccount.id);
    if (!result.ok) return "—";
    return formatAccountBalance(result.value, currentBook.homeCurrency);
  }

  function writeSummary(next: SummaryState, { replace = false }: { replace?: boolean } = {}) {
    const draft = new URLSearchParams(params);
    draft.delete("period");
    draft.delete("from");
    draft.delete("to");
    const summaryParams = toSummaryParams(next);
    for (const [key, value] of summaryParams) draft.set(key, value);
    setParams(draft, { replace });
  }

  function onPresetChange(value: string) {
    if (!isSummaryPreset(value)) return;
    if (value === "custom") {
      writeSummary(summary.preset === "custom" ? summary : { preset: "custom", from: "", to: "" });
    } else {
      writeSummary({ preset: value });
    }
  }

  const now = new Date();
  const bounds = summaryBounds(summary, now);
  const turnover = bounds ? app.turnoverInRange(currentBook, currentAccount.id, bounds) : null;

  function summaryValue(field: TurnoverField): string {
    if (!turnover || !turnover.ok) return "—";
    return formatTurnoverField(turnover.value, field, currentBook.homeCurrency);
  }

  const summaryRows: Array<{ key: string; field: TurnoverField }> =
    currentAccount.type === "income"
      ? [{ key: "received", field: "net" }]
      : currentAccount.type === "expense"
        ? [{ key: "spent", field: "net" }]
        : [
            { key: "inflow", field: "inflow" },
            { key: "outflow", field: "outflow" },
            { key: "change", field: "net" },
          ];

  async function onSave(event: FormEvent) {
    event.preventDefault();
    await run(
      () =>
        app.editAccount(currentBook, {
          id: currentAccount.id,
          name,
          parentId: isRoot ? undefined : parentId,
          isPlaceholder: isRoot ? undefined : isPlaceholder,
        }),
      () => setEditing(false),
    );
  }

  async function onDelete() {
    if (!confirm(t("accountDetail.deleteConfirm", { name: currentAccount.name }))) return;
    await run(
      () => app.removeAccount(currentBook, currentAccount.id),
      () => navigate("/accounts"),
    );
  }

  return (
    <main className="screen">
      <div className="screen-head">
        <Link className="icon-button back-button" to="/accounts" aria-label={t("common.backToAccounts")}>
          <ChevronBack />
        </Link>
        <h1>{currentAccount.name}</h1>
      </div>
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
        {isCategory ? null : (
          <div>
            <dt>{t("accountDetail.balanceLabel")}</dt>
            <dd>
              <Ltr>{balanceLabel()}</Ltr>
            </dd>
          </div>
        )}
        {currentAccount.isPlaceholder ? (
          <div>
            <dt>{t("accountDetail.nestedLabel")}</dt>
            <dd>{childCount}</dd>
          </div>
        ) : null}
      </dl>

      <section className="stack-form" aria-labelledby="period-summary-heading">
        <div className="group form-group">
          <label>
            {t("periodSummary.label")}
            <select value={summary.preset} onChange={(e) => onPresetChange(e.target.value)}>
              {SUMMARY_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {t(SUMMARY_PRESET_KEYS[preset])}
                </option>
              ))}
            </select>
          </label>
          {summary.preset === "custom" ? (
            <>
              <label>
                {t("periodSummary.from")}
                <input
                  type="date"
                  dir="ltr"
                  value={summary.from}
                  onChange={(e) => writeSummary({ ...summary, from: e.target.value }, { replace: true })}
                />
              </label>
              <label>
                {t("periodSummary.to")}
                <input
                  type="date"
                  dir="ltr"
                  value={summary.to}
                  onChange={(e) => writeSummary({ ...summary, to: e.target.value }, { replace: true })}
                />
              </label>
            </>
          ) : null}
        </div>
        <h2 id="period-summary-heading">{summaryLabel(summary, now)}</h2>
        {bounds === null ? (
          <p className="muted">{t("periodSummary.incomplete")}</p>
        ) : (
          <dl className="detail-list">
            {summaryRows.map((row) => (
              <div key={row.key}>
                <dt>{t(`periodSummary.${row.key}`)}</dt>
                <dd>
                  <Ltr>{summaryValue(row.field)}</Ltr>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {editing ? (
        <form className="stack-form" onSubmit={onSave}>
          <div className="group form-group">
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
          </div>
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
            to={`/journal?account=${currentAccount.id}&month=${summaryMonthParam(summary, now)}`}
          >
            {t("accountDetail.entries")}
          </Link>
          {currentAccount.isPlaceholder || currentAccount.id.startsWith("sys:") ? null : (
            <Link
              className="secondary link-button"
              to={`/accounts/${currentAccount.id}/opening-balance`}
            >
              {t("accountDetail.openingBalance")}
            </Link>
          )}
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
    </main>
  );
}
