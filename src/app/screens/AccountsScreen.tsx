import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { AccountBalance, AccountNode, Result } from "../../kernel";
import { accountFigure, monthFigureLabel, type AccountFigure } from "../account-figure";
import { formatAccountBalance } from "../format";
import { CaretDown, CaretRight } from "../components/icons";
import { Ltr } from "../components/Ltr";
import { useLedger } from "../ledger-context";

type Figures = Result<Map<string, AccountBalance>>;

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

  function figureLabel(accountId: string, figures: Figures): string {
    const value = figures.ok ? figures.value.get(accountId) : undefined;
    if (!value) return "—";
    return formatAccountBalance(value, currentBook.homeCurrency);
  }

  function renderNodes(nodes: AccountNode[], depth: number, figures: Figures) {
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
                <Ltr>{figureLabel(node.id, figures)}</Ltr>
              </span>
            </Link>
          </div>
          {isGroup && open ? (
            <ul className="account-children">{renderNodes(node.children, depth + 1, figures)}</ul>
          ) : null}
        </li>
      );
    });
  }

  /** One labelled run of root cards; nothing at all when the run is empty. */
  function renderSection(label: string, roots: { root: AccountNode }[], figures: Figures) {
    if (roots.length === 0) return null;
    return (
      <>
        <h2 className="section-label">{label}</h2>
        {roots.map(({ root }) => (
          <ul className="account-list group" key={root.id}>
            {renderNodes([root], 0, figures)}
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
        <Link className="primary link-button" to="/accounts/new">
          {t("accounts.addAccount")}
        </Link>
      </main>
    );
  }

  // Every account inherits its root's type, so the figure kind is decided per root.
  const roots = tree.value.map((root) => ({ root, figure: accountFigure(root.type, now) }));
  const balanceRoots = roots.filter((r) => r.figure.kind === "balance");
  const monthRoots = roots.filter((r) => r.figure.kind === "month");
  const monthFigure = roots.find((r) => r.figure.kind === "month")?.figure;
  const balances = app.balancesByAccount(currentBook);
  const monthBalances =
    monthFigure && monthFigure.kind === "month"
      ? app.balancesByAccount(currentBook, monthFigure.range)
      : null;

  return (
    <main className="screen">
      <h1>{t("accounts.title")}</h1>
      {renderSection(t("accounts.balanceSection"), balanceRoots, balances)}
      {monthFigure && monthFigure.kind === "month" && monthBalances
        ? renderSection(monthFigureLabel(monthFigure), monthRoots, monthBalances)
        : null}
      <Link className="primary link-button" to="/accounts/new">
        {t("accounts.addAccount")}
      </Link>
    </main>
  );
}
