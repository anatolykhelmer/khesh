import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { DueRow } from "../../service/ledger-app";
import { formatDate, formatMinor } from "../format";
import { Ltr } from "./Ltr";

/**
 * One due occurrence, in the app's list-row language: the whole row leads to the post
 * screen, and the one action that is taken most carries a text button beside it. Later
 * and Skip live on the post screen — nine rows of three buttons each was the wall this
 * replaces. The button is a sibling of the Link, never a child: a button inside a link
 * is neither.
 */
export function DueRowItem({
  row,
  onPost,
  busy,
}: {
  row: DueRow;
  onPost: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const date = formatDate(row.date);
  return (
    <li className="due-row">
      <Link className="due-main" to={`/recurring/${row.ruleId}/post/${row.date}`}>
        <div>
          <div className="due-title">{row.description}</div>
          <div className="muted"><Ltr>{date}</Ltr></div>
        </div>
        <div className="due-amount">
          <Ltr>{formatMinor(row.total, row.currency)}</Ltr>
        </div>
      </Link>
      <button
        type="button"
        className="row-action"
        onClick={onPost}
        disabled={busy}
        aria-label={t("recurring.postAria", { description: row.description, date })}
      >
        {t("recurring.post")}
      </button>
    </li>
  );
}
