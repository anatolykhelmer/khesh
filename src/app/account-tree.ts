import type { AccountNode, CurrencyCode } from "../kernel";

/** One rendered line of the picker: a node plus everything the row needs to draw itself. */
export type PickerRow = {
  id: string;
  name: string;
  path: string;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  isGroup: boolean;
  selectable: boolean;
  currency: CurrencyCode;
};

export type VisibleRowsOptions = {
  query: string;
  expanded: ReadonlySet<string>;
  groupsSelectable: boolean;
};

export function visibleRows(nodes: AccountNode[], opts: VisibleRowsOptions): PickerRow[] {
  const needle = opts.query.trim().toLowerCase();
  return needle === ""
    ? browseRows(nodes, opts.expanded, opts.groupsSelectable, 0, "")
    : searchRows(nodes, needle, opts.groupsSelectable, 0, "");
}

function browseRows(
  nodes: AccountNode[],
  expanded: ReadonlySet<string>,
  groupsSelectable: boolean,
  depth: number,
  parentPath: string,
): PickerRow[] {
  return nodes.flatMap((node) => {
    const path = joinPath(parentPath, node.name);
    const open = expanded.has(node.id);
    const row = toRow(node, path, depth, open, groupsSelectable);
    if (!open) return [row];
    return [row, ...browseRows(node.children, expanded, groupsSelectable, depth + 1, path)];
  });
}

/**
 * Matching on the full path means a matching group's descendants match too — their
 * paths contain it — so a matched subtree comes back whole. Ancestors of a match are
 * pulled in as context even when they do not match themselves.
 */
function searchRows(
  nodes: AccountNode[],
  needle: string,
  groupsSelectable: boolean,
  depth: number,
  parentPath: string,
): PickerRow[] {
  return nodes.flatMap((node) => {
    const path = joinPath(parentPath, node.name);
    const children = searchRows(node.children, needle, groupsSelectable, depth + 1, path);
    if (children.length === 0 && !path.toLowerCase().includes(needle)) return [];
    return [toRow(node, path, depth, true, groupsSelectable), ...children];
  });
}

function toRow(
  node: AccountNode,
  path: string,
  depth: number,
  expanded: boolean,
  groupsSelectable: boolean,
): PickerRow {
  const hasChildren = node.children.length > 0;
  return {
    id: node.id,
    name: node.name,
    path,
    depth,
    hasChildren,
    expanded: hasChildren && expanded,
    isGroup: node.isPlaceholder,
    selectable: !node.isPlaceholder || groupsSelectable,
    currency: node.currency,
  };
}

function joinPath(parentPath: string, name: string): string {
  return parentPath === "" ? name : `${parentPath}:${name}`;
}

/** Ancestors of the selected account, so the sheet opens with the selection in view. */
export function expandedForSelection(
  nodes: AccountNode[],
  selectedId: string | null,
): Set<string> {
  const found = new Set<string>();
  if (selectedId === null) return found;

  const walk = (node: AccountNode, ancestors: string[]): boolean => {
    if (node.id === selectedId) {
      for (const id of ancestors) found.add(id);
      return true;
    }
    return node.children.some((child) => walk(child, [...ancestors, node.id]));
  };

  nodes.some((node) => walk(node, []));
  return found;
}

/** Full path of an account, e.g. "Expenses:Food". The tree-side twin of `accountPathLabel`. */
export function pathOf(nodes: AccountNode[], id: string | null): string | null {
  if (id === null) return null;

  const walk = (list: AccountNode[], parentPath: string): string | null => {
    for (const node of list) {
      const path = joinPath(parentPath, node.name);
      if (node.id === id) return path;
      const nested = walk(node.children, path);
      if (nested !== null) return nested;
    }
    return null;
  };

  return walk(nodes, "");
}
