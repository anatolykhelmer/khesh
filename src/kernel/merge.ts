import { canonicalJson } from "./canonical-json";
import { err, ok, type Result } from "./result";
import { budgetKeyOf } from "./tombstones";
import type { Account, Book, Budget, JournalEntry, Tombstone, TombstoneKind } from "./types";

type AnyRecord = Account | JournalEntry | Budget;
type Claim =
  | { alive: true; at: string; record: AnyRecord }
  | { alive: false; at: string; stone: Tombstone };

function claimBody(claim: Claim): unknown {
  return claim.alive ? claim.record : claim.stone;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Later timestamp wins; a live/dead tie keeps the data; a same-shape tie picks the
 * canonically greater body so both argument orders agree. */
function later(a: Claim, b: Claim): Claim {
  if (a.at !== b.at) return a.at > b.at ? a : b;
  if (a.alive !== b.alive) return a.alive ? a : b;
  return canonicalJson(claimBody(a)) >= canonicalJson(claimBody(b)) ? a : b;
}

function collectClaims(book: Book): Map<string, Claim> {
  const map = new Map<string, Claim>();
  for (const account of book.accounts) {
    map.set(`account|${account.id}`, { alive: true, at: account.updatedAt, record: account });
  }
  for (const entry of book.journal) {
    map.set(`entry|${entry.id}`, { alive: true, at: entry.updatedAt, record: entry });
  }
  for (const budget of book.budgets) {
    map.set(`budget|${budgetKeyOf(budget)}`, { alive: true, at: budget.updatedAt, record: budget });
  }
  for (const stone of book.tombstones) {
    map.set(`${stone.kind}|${stone.key}`, { alive: false, at: stone.deletedAt, stone });
  }
  return map;
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return compareStrings(a.id, b.id);
}

/**
 * Mutates `book`. Called before the repair ladder as well as after it: the draft is
 * assembled in argument order, and the ladder walks the arrays in order (the sibling
 * dedupe below groups and renames as it goes), so a canonical order going in is what
 * keeps `mergeBooks(a, b)` and `mergeBooks(b, a)` on the same path.
 */
function sortBook(book: Book): void {
  book.accounts.sort(byId);
  book.journal.sort(byId);
  book.budgets.sort((x, y) => compareStrings(budgetKeyOf(x), budgetKeyOf(y)));
  book.tombstones.sort((x, y) =>
    compareStrings(`${x.kind}|${x.key}`, `${y.kind}|${y.key}`),
  );
}

/** Deterministic repair of a merged draft. Mutates `draft`. Returns false when the
 * conflict is irreducible (an account holds both children and postings). */
function repair(draft: Book): boolean {
  // 1. Restore referenced accounts from tombstones, transitively (parents included).
  //    Every pass consumes at least one tombstone, so the loop cannot spin.
  for (;;) {
    const live = new Set(draft.accounts.map((a) => a.id));
    const referenced = new Set<string>();
    for (const account of draft.accounts) {
      if (account.parentId !== null) referenced.add(account.parentId);
    }
    for (const entry of draft.journal) {
      for (const posting of entry.postings) referenced.add(posting.accountId);
    }
    for (const budget of draft.budgets) referenced.add(budget.accountId);

    const missing = [...referenced].filter((id) => !live.has(id)).sort();
    if (missing.length === 0) break;
    for (const id of missing) {
      const stone = draft.tombstones.find((t) => t.kind === "account" && t.key === id);
      if (!stone) return false; // unreachable from valid inputs; refuse rather than invent
      draft.accounts.push(structuredClone(stone.record) as Account);
      // A resurrected record must not leave its tombstone behind — that shadowing
      // is exactly what validateBook rejects.
      draft.tombstones = draft.tombstones.filter((t) => t !== stone);
    }
  }

  // 2. Placeholder consistency: children force it on; postings force it off; both is irreducible.
  const withChildren = new Set(
    draft.accounts.filter((a) => a.parentId !== null).map((a) => a.parentId as string),
  );
  const posted = new Set(draft.journal.flatMap((e) => e.postings.map((p) => p.accountId)));
  for (const account of draft.accounts) {
    const hasChild = withChildren.has(account.id);
    const hasPosting = posted.has(account.id);
    if (hasChild && hasPosting) return false;
    if (hasChild && !account.isPlaceholder) account.isPlaceholder = true;
    if (hasPosting && account.isPlaceholder) account.isPlaceholder = false;
  }

  // 3. Cascade parent types down mismatched descendants (top-down, deterministic order).
  //    `seen` stops a parent cycle that reached here unvalidated from recursing forever.
  const seen = new Set<string>();
  const cascade = (parent: Account) => {
    for (const child of draft.accounts.filter((a) => a.parentId === parent.id).sort(byId)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      if (child.type !== parent.type) child.type = parent.type;
      cascade(child);
    }
  };
  for (const root of draft.accounts.filter((a) => a.parentId === null).sort(byId)) {
    seen.add(root.id);
    cascade(root);
  }

  // 4. Deduplicate sibling names: canonically greatest record keeps the name.
  const bySibling = new Map<string, Account[]>();
  for (const account of draft.accounts) {
    const slot = `${account.parentId ?? ""}|${account.name}`;
    bySibling.set(slot, [...(bySibling.get(slot) ?? []), account]);
  }
  for (const group of [...bySibling.values()]) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) =>
      canonicalJson(a) >= canonicalJson(b) ? -1 : 1,
    );
    for (let i = 1; i < ordered.length; i += 1) {
      let n = i + 1;
      const taken = (name: string) =>
        draft.accounts.some(
          (a) => a !== ordered[i] && a.parentId === ordered[i].parentId && a.name === name,
        );
      let candidate = `${ordered[i].name} ${n}`;
      while (taken(candidate)) {
        n += 1;
        candidate = `${ordered[i].name} ${n}`;
      }
      ordered[i].name = candidate;
    }
  }

  // 5. A budget only makes sense on a live expense account.
  const liveById = new Map(draft.accounts.map((a) => [a.id, a]));
  draft.budgets = draft.budgets.filter((budget) => {
    const account = liveById.get(budget.accountId);
    return account !== undefined && account.type === "expense";
  });

  return true;
}

export function mergeBooks(a: Book, b: Book): Result<Book> {
  const merged = new Map(collectClaims(a));
  for (const [key, claim] of collectClaims(b)) {
    const existing = merged.get(key);
    merged.set(key, existing ? later(existing, claim) : claim);
  }

  const metaFromA =
    a.metaUpdatedAt !== b.metaUpdatedAt
      ? a.metaUpdatedAt > b.metaUpdatedAt
      : canonicalJson({ name: a.name, homeCurrency: a.homeCurrency }) >=
        canonicalJson({ name: b.name, homeCurrency: b.homeCurrency });
  const meta = metaFromA ? a : b;

  const draft: Book = {
    schemaVersion: 2,
    name: meta.name,
    homeCurrency: meta.homeCurrency,
    metaUpdatedAt: meta.metaUpdatedAt,
    accounts: [],
    journal: [],
    budgets: [],
    tombstones: [],
  };
  for (const [key, claim] of merged) {
    const kind = key.slice(0, key.indexOf("|")) as TombstoneKind;
    if (!claim.alive) {
      draft.tombstones.push(structuredClone(claim.stone));
    } else if (kind === "account") {
      draft.accounts.push(structuredClone(claim.record) as Account);
    } else if (kind === "entry") {
      draft.journal.push(structuredClone(claim.record) as JournalEntry);
    } else {
      draft.budgets.push(structuredClone(claim.record) as Budget);
    }
  }

  sortBook(draft);
  if (!repair(draft)) {
    return err("SYNC_MERGE_CONFLICT", "Books conflict beyond automatic repair");
  }
  sortBook(draft);
  return ok(draft);
}
