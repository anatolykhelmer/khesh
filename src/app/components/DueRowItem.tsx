import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { DueRow } from "../../service/ledger-app";
import { formatDate, formatMinor } from "../format";
import { Ltr } from "./Ltr";

export function DueRowItem({
  row,
  onPost,
  onSkip,
  onDefer,
  busy,
}: {
  row: DueRow;
  onPost: () => void;
  onSkip: () => void;
  onDefer: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  return (
    <li className="due-row">
      <Link className="due-main" to={`/recurring/${row.ruleId}/post/${row.date}`}>
        <div>
          <div className="due-title">{row.description}</div>
          <div className="muted">{formatDate(row.date)}</div>
        </div>
        <div className="due-amount">
          <Ltr>{formatMinor(row.total, row.currency)}</Ltr>
        </div>
      </Link>
      <div className="due-actions">
        <button type="button" className="primary" onClick={onPost} disabled={busy}>
          {t("recurring.post")}
        </button>
        <button type="button" className="secondary" onClick={onDefer} disabled={busy}>
          {t("recurring.defer")}
        </button>
        <button type="button" className="secondary" onClick={onSkip} disabled={busy}>
          {t("recurring.skip")}
        </button>
      </div>
    </li>
  );
}
