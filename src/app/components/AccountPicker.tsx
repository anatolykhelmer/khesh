import type { MouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AccountNode } from "../../kernel";
import { expandedForSelection, pathOf, visibleRows } from "../account-tree";

type Props = {
  /** From `app.accountTree(book)`, which has already dropped `sys:` accounts. */
  nodes: AccountNode[];
  value: string | null;
  onChange: (id: string | null) => void;
  /** Sheet heading and the trigger's accessible name, e.g. "Filter by account". Already translated. */
  label: string;
  groupsSelectable: boolean;
  /** Renders a reset row above the tree. Omit where a value is required. Already translated. */
  allOptionLabel?: string;
  /** Trigger text when nothing is selected. Already translated. */
  placeholder: string;
};

export function AccountPicker({
  nodes,
  value,
  onChange,
  label,
  groupsSelectable,
  allOptionLabel,
  placeholder,
}: Props) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  // `showModal()` is what buys the focus trap, Esc and page inertness, so the dialog
  // is opened through the DOM rather than by rendering it conditionally.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const selectedPath = pathOf(nodes, value);
  const triggerText = selectedPath ? (selectedPath.split(":").pop() ?? placeholder) : placeholder;
  const searching = query.trim() !== "";
  const rows = visibleRows(nodes, { query, expanded, groupsSelectable });

  function openSheet() {
    setQuery("");
    setExpanded(expandedForSelection(nodes, value));
    setOpen(true);
  }

  function choose(id: string | null) {
    onChange(id);
    setOpen(false);
  }

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  // Clicks on ::backdrop are reported with the dialog itself as the target.
  function onDialogClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === dialogRef.current) setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        className="picker-trigger"
        aria-label={label}
        aria-haspopup="dialog"
        title={selectedPath ?? undefined}
        onClick={openSheet}
      >
        {triggerText}
      </button>
      <dialog
        ref={dialogRef}
        className="picker"
        aria-label={label}
        onClose={() => setOpen(false)}
        onClick={onDialogClick}
      >
        <div className="picker-head">
          <h2>{label}</h2>
          <button type="button" className="secondary" onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </button>
        </div>
        <div className="picker-search-row">
          {/* Deliberately not autofocused: on a phone the keyboard would cover the tree. */}
          <input
            className="picker-search"
            aria-label={t("accountPicker.searchAria", { label })}
            placeholder={t("accountPicker.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <ul className="picker-tree">
          {allOptionLabel ? (
            <li>
              <div className="picker-row">
                <span className="twisty spacer" aria-hidden="true" />
                <button
                  type="button"
                  className="picker-name"
                  aria-current={value === null}
                  onClick={() => choose(null)}
                >
                  <span>{allOptionLabel}</span>
                  {value === null ? <span aria-hidden="true">✓</span> : null}
                </button>
              </div>
            </li>
          ) : null}
          {rows.map((row) => (
            <li key={row.id}>
              <div className="picker-row" style={{ paddingInlineStart: `${row.depth * 16}px` }}>
                {row.hasChildren && !searching ? (
                  <button
                    type="button"
                    className="twisty"
                    aria-expanded={row.expanded}
                    aria-label={
                      row.expanded
                        ? t("common.collapse", { name: row.name })
                        : t("common.expand", { name: row.name })
                    }
                    onClick={() => toggle(row.id)}
                  >
                    {row.expanded ? "▾" : "▸"}
                  </button>
                ) : (
                  <span className="twisty spacer" aria-hidden="true">
                    {row.hasChildren ? "▾" : ""}
                  </span>
                )}
                <button
                  type="button"
                  className="picker-name"
                  aria-label={row.path}
                  aria-current={row.id === value}
                  disabled={!row.selectable && (!row.hasChildren || searching)}
                  onClick={() => (row.selectable ? choose(row.id) : toggle(row.id))}
                >
                  <span>
                    {row.name}
                    {row.isGroup ? null : (
                      <span className="picker-currency"> {row.currency}</span>
                    )}
                  </span>
                  {row.id === value ? <span aria-hidden="true">✓</span> : null}
                </button>
              </div>
            </li>
          ))}
          {rows.length === 0 && searching ? (
            <li className="picker-empty">{t("accountPicker.noMatch")}</li>
          ) : null}
        </ul>
      </dialog>
    </>
  );
}
