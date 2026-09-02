import { canonicalJson } from "./canonical-json";
import { err, ok, type Result } from "./result";
import { budgetKeyOf } from "./tombstones";
import type {
  Account,
  Book,
  Budget,
  CurrencyCode,
  JournalEntry,
  Tombstone,
  TombstoneKind,
} from "./types";

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
 * Mutates `book`. Run before the repair ladder as well as after it, for two different
 * reasons. Going in: the draft is assembled in `Map` insertion order, which is argument
 * order, and rung 5 groups siblings by walking `accounts` — a canonical order there is
 * what makes its grouping (and so its renames) independent of which book came first.
 * That is all the pre-sort guarantees: rung 1 appends restored accounts behind it, so
 * the arrays are no longer sorted by the time rungs 2-6 run. Coming out: the sort is
 * what puts the merged book itself in canonical order.
 */
function sortBook(book: Book): void {
  book.accounts.sort(byId);
  book.journal.sort(byId);
  book.budgets.sort((x, y) => compareStrings(budgetKeyOf(x), budgetKeyOf(y)));
  book.tombstones.sort((x, y) =>
    compareStrings(`${x.kind}|${x.key}`, `${y.kind}|${y.key}`),
  );
}

/**
 * The ids of one parent cycle, or null when every account reaches a root. Accounts are
 * walked in `id` order and the first cycle found is returned, so repeated calls detach
 * cycles in the same sequence whichever book was merged first.
 */
function findCycle(accounts: Account[], index: Map<string, Account>): string[] | null {
  const grounded = new Set<string>();
  for (const start of [...accounts].sort(byId)) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let current: Account | undefined = start;
    while (current !== undefined && !grounded.has(current.id)) {
      if (onPath.has(current.id)) return path.slice(path.indexOf(current.id));
      path.push(current.id);
      onPath.add(current.id);
      current = current.parentId === null ? undefined : index.get(current.parentId);
    }
    for (const id of path) grounded.add(id);
  }
  return null;
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

  // 2. Break parent cycles. `wouldCreateCycle` only ever sees one device's book, so
  //    moving G1 under G2 here while G2 moves under G1 there is legal on both and a
  //    cycle only exists after the union. Nothing is lost by detaching — one parentId
  //    changes, no record disappears — so this is repaired, not refused. The lowest-id
  //    member is the one cut loose: deterministic, and the same in either argument
  //    order. Runs before the rungs below because a cycle hides its members from the
  //    type cascade entirely, and because the mutual parenthood it invents would
  //    otherwise read as a genuine children-and-postings conflict in rung 3.
  //    Each pass clears one parentId, so the loop is bounded by the account count.
  for (;;) {
    const index = new Map(draft.accounts.map((a) => [a.id, a]));
    const cycle = findCycle(draft.accounts, index);
    if (cycle === null) break;
    const lowest = cycle.reduce((low, id) => (id < low ? id : low));
    const detached = index.get(lowest);
    if (detached === undefined) break; // cycle ids come from index; unreachable
    detached.parentId = null;
  }

  // 3. Placeholder consistency: children force it on; postings force it off; both is irreducible.
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

  // 4. Cascade parent types down mismatched descendants (top-down, deterministic order).
  //    `seen` is redundant now that rung 2 leaves a forest behind — it stays so that a
  //    regression there surfaces as a wrong account type rather than a stack overflow.
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

  // 5. Deduplicate sibling names: canonically greatest record keeps the name. The slot
  //    key is JSON-encoded rather than concatenated so a name containing the separator
  //    cannot masquerade as a different parent — ids never do, a hand-edited file might.
  const bySibling = new Map<string, Account[]>();
  for (const account of draft.accounts) {
    const slot = canonicalJson([account.parentId, account.name]);
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

  // 6. A budget only makes sense on an expense account. Rung 1 has already restored
  //    every account a budget references, so this drops exactly the limits whose
  //    account was concurrently retyped away from expense.
  const typeById = new Map(draft.accounts.map((a) => [a.id, a.type]));
  draft.budgets = draft.budgets.filter((b) => typeById.get(b.accountId) === "expense");

  return true;
}

function currencyIndex(book: Book): Map<string, CurrencyCode> {
  return new Map(book.accounts.map((account) => [account.id, account.currency]));
}

/**
 * True while every entry still means what the device that holds it recorded.
 *
 * Changing an account's currency is legal on a device with no postings on it, and
 * posting to that account is legal on a device that never changed it — but the union
 * silently reinterprets money: 100 entered as ILS reads as 100 USD, and validateBook
 * stays green because nothing structural broke. With `fx` in play it breaks loudly
 * instead (ENTRY_FX_RATE_MISMATCH). Neither is repairable — which currency the amount
 * meant is not recoverable from the merge — so this one is refused.
 *
 * Compared per posting-account rather than over the entry's currency multiset: two
 * accounts swapping currencies inside one entry leaves the multiset identical while
 * inverting what the entry says. A source that never knew an account says nothing
 * about it. Both books are checked the same way, so the verdict is symmetric.
 */
function entryMeaningHeld(draft: Book, sources: readonly Book[]): boolean {
  const after = currencyIndex(draft);
  for (const source of sources) {
    const before = currencyIndex(source);
    const carried = new Set(source.journal.map((entry) => entry.id));
    for (const entry of draft.journal) {
      if (!carried.has(entry.id)) continue;
      for (const posting of entry.postings) {
        const was = before.get(posting.accountId);
        if (was !== undefined && was !== after.get(posting.accountId)) return false;
      }
    }
  }
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
  // Runs on the repaired draft: rung 1 decides which accounts are live at all, and
  // therefore which currency each posting resolves to.
  if (!entryMeaningHeld(draft, [a, b])) {
    return err(
      "SYNC_MERGE_CONFLICT",
      "An account currency changed under an entry posted on the other device",
    );
  }
  sortBook(draft);
  return ok(draft);
}
