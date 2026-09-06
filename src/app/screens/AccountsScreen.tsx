import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { AccountNode } from "../../kernel";
import { currentYearMonth } from "../../service/dates";
import { accountFigure, monthFigureLabel, type AccountFigure } from "../account-figure";
import { formatAccountBalance } from "../format";
import { CaretDown, CaretRight } from "../components/icons";
import { Ltr } from "../components/Ltr";
import { useLedger } from "../ledger-context";

export function AccountsScreen() {
  const { t } = useTranslation();
  const { book, app } = useLedger();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  if (!book) return null;

  const currentBook = book;
  const tree = app.accountTree(currentBook);
  const now = new Date();

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function figureLabel(accountId: string, figure: AccountFigure): string {
    const result =
      figure.kind === "month"
        ? app.balanceInRange(currentBook, accountId, figure.range)
        : app.balanceOf(currentBook, accountId);
    if (!result.ok) return "—";
    return formatAccountBalance(result.value, currentBook.homeCurrency);
  }

  function renderNodes(nodes: AccountNode[], depth: number, figure: AccountFigure) {
    return nodes.map((node) => {
      const isGroup = node.children.length > 0;
      const open = expanded.has(node.id);
      return (
        <li key={node.id}>
          <div className="account-row" style={{ paddingInlineStart: `${depth * 16}px` }}>
            {isGroup ? (
              <button
                type="button"
                className="twisty"
                aria-expanded={open}
                aria-label={
                  open
                    ? t("common.collapse", { name: node.name })
                    : t("common.expand", { name: node.name })
                }
                onClick={() => toggle(node.id)}
              >
                {open ? <CaretDown /> : <CaretRight />}
              </button>
            ) : (
              <span className="twisty" aria-hidden="true" />
            )}
            <Link className="account-link" to={`/accounts/${node.id}`}>
              <span>{node.name}</span>
              <span className="muted">
                <Ltr>{figureLabel(node.id, figure)}</Ltr>
              </span>
            </Link>
          </div>
          {isGroup && open ? (
            <ul className="account-children">{renderNodes(node.children, depth + 1, figure)}</ul>
          ) : null}
        </li>
      );
    });
  }

  /** One labelled run of root cards; nothing at all when the run is empty. */
  function renderSection(label: string, roots: AccountNode[]) {
    if (roots.length === 0) return null;
    return (
      <>
        <h2 className="section-label">{label}</h2>
        {roots.map((root) => (
          <ul className="account-list group" key={root.id}>
            {renderNodes([root], 0, accountFigure(root.type, now))}
          </ul>
        ))}
      </>
    );
  }

  if (!tree.ok) {
    return (
      <main className="screen">
        <h1>{t("accounts.title")}</h1>
        <p className="muted">{t("accounts.couldNotLoad")}</p>
      </main>
    );
  }

  // Every account inherits its root's type, so the figure kind is decided per root.
  const balanceRoots = tree.value.filter((root) => accountFigure(root.type, now).kind === "balance");
  const monthRoots = tree.value.filter((root) => accountFigure(root.type, now).kind === "month");

  return (
    <main className="screen">
      <h1>{t("accounts.title")}</h1>
      {renderSection(t("accounts.balanceSection"), balanceRoots)}
      {renderSection(monthFigureLabel(currentYearMonth(now)), monthRoots)}
      <Link className="primary link-button" to="/accounts/new">
        {t("accounts.addAccount")}
      </Link>
    </main>
  );
}
