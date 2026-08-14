import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { AccountNode } from "../../kernel";
import { formatMinor } from "../format";
import { Ltr } from "../components/Ltr";
import { useLedger } from "../ledger-context";

export function AccountsScreen() {
  const { t } = useTranslation();
  const { book, app } = useLedger();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  if (!book) return null;

  const currentBook = book;
  const tree = app.accountTree(currentBook);

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function balanceLabel(accountId: string): string {
    const result = app.balanceOf(currentBook, accountId);
    if (!result.ok) return "—";
    const bal = result.value;
    if (bal.kind === "leaf") {
      return formatMinor(bal.amount, bal.currency);
    }
    const parts = Object.entries(bal.balances)
      .filter(([, amount]) => amount !== 0)
      .sort(([a], [b]) => {
        if (a === currentBook.homeCurrency) return -1;
        if (b === currentBook.homeCurrency) return 1;
        return a.localeCompare(b);
      })
      .map(([currency, amount]) => formatMinor(amount, currency));
    return parts.length === 0 ? formatMinor(0, currentBook.homeCurrency) : parts.join(" · ");
  }

  function renderNodes(nodes: AccountNode[], depth: number) {
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
                {open ? "▾" : "▸"}
              </button>
            ) : (
              <span className="twisty spacer" aria-hidden="true" />
            )}
            <Link className="account-link" to={`/accounts/${node.id}`}>
              <span>{node.name}</span>
              <span className="muted">
                <Ltr>{balanceLabel(node.id)}</Ltr>
              </span>
            </Link>
          </div>
          {isGroup && open ? (
            <ul className="account-children">{renderNodes(node.children, depth + 1)}</ul>
          ) : null}
        </li>
      );
    });
  }

  return (
    <main className="screen">
      <h1>{t("accounts.title")}</h1>
      {!tree.ok ? (
        <p className="muted">{t("accounts.couldNotLoad")}</p>
      ) : (
        <ul className="account-list">{renderNodes(tree.value, 0)}</ul>
      )}
      <Link className="primary link-button" to="/accounts/new">
        {t("accounts.addAccount")}
      </Link>
    </main>
  );
}
