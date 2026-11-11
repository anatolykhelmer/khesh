import { wouldCreateCycle } from "./book-utils";
import { canonicalJson } from "./canonical-json";
import { err, ok, type Result } from "./result";
import { isSeedAccountId } from "./seed-ids";
import { addTombstone, budgetKeyOf, clearTombstone } from "./tombstones";
import type {
  Account,
  Book,
  Budget,
  JournalEntry,
  Recurrence,
  Tombstone,
  TombstoneKind,
} from "./types";

type AnyRecord = Account | JournalEntry | Budget | Recurrence;
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

function* liveClaims(book: Book): Generator<[string, Claim]> {
  for (const account of book.accounts) {
    yield [`account|${account.id}`, { alive: true, at: account.updatedAt, record: account }];
  }
  for (const entry of book.journal) {
    yield [`entry|${entry.id}`, { alive: true, at: entry.updatedAt, record: entry }];
  }
  for (const budget of book.budgets) {
    yield [
      `budget|${budgetKeyOf(budget)}`,
      { alive: true, at: budget.updatedAt, record: budget },
    ];
  }
  for (const rule of book.recurrences) {
    yield [`recurrence|${rule.id}`, { alive: true, at: rule.updatedAt, record: rule }];
  }
}

function collectClaims(book: Book): Map<string, Claim> {
  const map = new Map<string, Claim>(liveClaims(book));
  for (const stone of book.tombstones) {
    map.set(`${stone.kind}|${stone.key}`, { alive: false, at: stone.deletedAt, stone });
  }
  return map;
}

/**
 * The newest live version of each account across the inputs, tombstones ignored —
 * including the versions a tombstone outranked and so kept out of the draft.
 *
 * Rung 1 weighs these against the tombstone's own snapshot rather than preferring
 * either outright. A live copy the other device went on editing is usually the newer
 * one, and restoring the snapshot instead would throw that edit away — and not settle,
 * since re-merging the device that still holds the newer copy would reinstate it. But
 * the deleting device may equally have been the last to edit the record before deleting
 * it, and then its snapshot is the newest version anywhere; that is why the two are
 * compared by `updatedAt` rather than ranked by where they came from.
 */
function latestLiveAccounts(books: readonly Book[]): Map<string, Account> {
  const claims = new Map<string, Claim>();
  for (const book of books) {
    for (const [key, claim] of liveClaims(book)) {
      if (!key.startsWith("account|")) continue;
      const existing = claims.get(key);
      claims.set(key, existing ? later(existing, claim) : claim);
    }
  }
  const newest = new Map<string, Account>();
  for (const [key, claim] of claims) {
    if (claim.alive) newest.set(key.slice("account|".length), claim.record as Account);
  }
  return newest;
}

/** The newer of two live versions of one account, using `later`'s convention: greater
 * `updatedAt`, and on a tie the canonically greater body so both argument orders agree. */
function newerAccount(a: Account, b: Account): Account {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return canonicalJson(a) >= canonicalJson(b) ? a : b;
}

/**
 * Every input copy of each account, by id — the versions last-writer-wins discarded as well
 * as the one it kept.
 *
 * `latestLiveAccounts` answers "what is the newest version of this record". Rung 2's
 * re-attachment needs the opposite: a parent the winning version does *not* have, because
 * the winning version is the one that points into the cycle. A tombstoned copy never shows
 * up here — not because anything filters it out, but because this only reads `book.accounts`,
 * which holds live records to begin with, so a deleted copy was never a candidate to send an
 * account back to in the first place.
 */
function accountVersions(books: readonly Book[]): Map<string, Account[]> {
  const versions = new Map<string, Account[]>();
  for (const book of books) {
    for (const account of book.accounts) {
      versions.set(account.id, [...(versions.get(account.id) ?? []), account]);
    }
  }
  return versions;
}

/**
 * The parent a cut-loose cycle member goes back under, or null to leave it at the top level.
 *
 * Four answers, in order, and the first one whose parent still matches the member's current
 * type wins outright — a mismatch is accepted only once every type-matching answer has been
 * ruled out. "Matches" is checked against the *parent*'s type as it stands in the draft right
 * now, never the snapshot's own `type` field: what actually decides whether rung 4's cascade
 * fires is the type the named parent currently carries, and a snapshot's own type can still be
 * accurate — the member really was that type, on that device, when it pointed there — while the
 * parent it names has since been retyped by the *other* device. Comparing the snapshot's own
 * type instead would accept a candidate whose parent no longer agrees with it, and the cascade
 * would fire anyway.
 *
 * First, the parent it last had outside the cycle: the input copies are the history of where
 * the account lived before the two devices tied the knot, and the newest of them that points
 * outside the cycle *and can still take a child* is the last place a user actually put it.
 * Among those, one whose named parent's draft type still matches the member's current type is
 * tried before any whose named parent's type does not, newest first within each group. A
 * parent that holds postings cannot take a child — handing the member to it would create
 * exactly the children-and-postings pair rung 3 calls irreducible — so a candidate like that is
 * skipped in favour of the next-newest (within its type group, then the other), and only once
 * none of the input copies qualify does the ladder fall through.
 *
 * Second, the lowest-id top-level placeholder of the member's own type: ordinarily the category
 * root. This is where the ladder turns to *before* accepting a differently-typed answer from the
 * first: handing the member a mismatched parent would give rung 4's cascade a reason to retype
 * the member (and its subtree) to match, and if a posted entry relies on any of it,
 * `entryMeaningBroken` then refuses the whole merge for a type change no device actually made —
 * this rung exists to repair the cycle without manufacturing that refusal, so a same-type root
 * is preferred over a differently-typed history candidate rather than the other way around. A
 * member cut loose from the same cycle usually does not linger here as a stand-in for it: this
 * same loop re-attaches cut-loose members in id order, so a sibling with a lower id has usually
 * already been sent to the type root by this same second answer before this member's lookup
 * runs. That is not absolute, though — when the draft holds no root of that type at all (the
 * imported-book case the fourth answer below contemplates), the lower-id sibling's own lookup
 * falls all the way to park, and a parked account *is* a top-level placeholder of its type, so
 * it remains exactly the kind of candidate this second answer looks for and a later member's
 * lookup can still name it.
 *
 * Third, back to the first answer's own best candidate even though its named parent's type
 * does not match — reached only when neither of the first two answers offered one that does.
 * This is the one case where the result carries a type mismatch through to rung 4; it is still
 * preferred over parking, since it keeps more of the account's history than starting it over at
 * the top level.
 *
 * Fourth, null: park it, which is what this rung did for every member before BL-048. The fourth
 * is reached only when a book holds no root of the member's type at all — which `createHousehold`
 * cannot produce and an imported book can — or when every candidate, root included, already
 * holds postings, which a valid book cannot produce (a posted account cannot be a placeholder,
 * so it cannot be this member's outside parent either) but an imported or hand-edited one might.
 *
 * Every candidate is checked three ways: still live in the draft, not reachable *from* the
 * member — re-attaching to a descendant would tie a fresh knot around the one just cut — and
 * not posted to, since an account with postings cannot also take a child. `wouldCreateCycle`
 * answers the second question against the draft as it stands, which is after the detach loop
 * and therefore acyclic.
 *
 * The type preference — both within the first answer and between the first three answers — still
 * agrees in both argument orders of `mergeBooks`, even though it now reads the draft rather than
 * the candidate record alone: the draft it reads is the post-union, canonically sorted book that
 * `repair` starts from, which is the same set of accounts with the same fields regardless of
 * which side of `mergeBooks(a, b)` supplied `a` — `later`/`newerAccount` already agree in both
 * orders, and rung 2's own detach loop mutates the same ids the same way whichever book was
 * merged first (see its own comment above). So looking up a parent's current type in that draft,
 * rather than trusting the candidate's own copy of it, is still a pure function of the two input
 * books, never of `versions`' or an array's iteration order.
 */
function reattachTarget(
  draft: Book,
  member: Account,
  cycle: ReadonlySet<string>,
  versions: Map<string, Account[]>,
  posted: ReadonlySet<string>,
): string | null {
  const draftById = new Map(draft.accounts.map((a) => [a.id, a]));
  const usable = (parentId: string): boolean =>
    parentId !== member.id &&
    draftById.has(parentId) &&
    !posted.has(parentId) &&
    !wouldCreateCycle(draft, member.id, parentId);
  // The parent's own draft type, not the snapshot's — see the doc comment above. Undefined
  // for a parent no longer live, which only ever matters for a candidate `usable` excludes.
  const draftType = (parentId: string): Account["type"] | undefined => draftById.get(parentId)?.type;

  const outside = (versions.get(member.id) ?? [])
    .filter(
      (version): version is Account & { parentId: string } =>
        version.parentId !== null && !cycle.has(version.parentId),
    )
    .sort((x, y) => {
      const xMatches = draftType(x.parentId) === member.type;
      const yMatches = draftType(y.parentId) === member.type;
      if (xMatches !== yMatches) return xMatches ? -1 : 1;
      return newerAccount(x, y) === x ? -1 : 1;
    });
  const reattachable = outside.find((version) => usable(version.parentId));
  if (reattachable !== undefined && draftType(reattachable.parentId) === member.type) {
    return reattachable.parentId;
  }

  const root = draft.accounts
    .filter((a) => a.parentId === null && a.isPlaceholder && a.type === member.type)
    .filter((a) => !a.id.startsWith("sys:") && usable(a.id))
    .sort(byId)[0];
  if (root !== undefined) return root.id;

  if (reattachable !== undefined) return reattachable.parentId;
  return null;
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return compareStrings(a.id, b.id);
}

/** The top-level placeholder that survives a same-type collapse. A seed id wins outright:
 * it is the id every newer build mints, so a book that predates them converges on it rather
 * than dragging a device-local ULID forward. Otherwise `later`'s convention — greater
 * `updatedAt`, then the canonically greater body — so both argument orders agree. */
function betterRoot(a: Account, b: Account): Account {
  const aSeed = isSeedAccountId(a.id);
  const bSeed = isSeedAccountId(b.id);
  if (aSeed !== bSeed) return aSeed ? a : b;
  return newerAccount(a, b);
}

/** The newer of two budgets that collided on the same (accountId, period, currency) key
 * after the root-collapse rung repointed one onto the other's account — `later`'s
 * convention again: greater `updatedAt`, then the canonically greater body, so both
 * argument orders agree. */
function newerBudget(a: Budget, b: Budget): Budget {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return canonicalJson(a) >= canonicalJson(b) ? a : b;
}

/**
 * Mutates `book`. Run before the repair ladder as well as after it, for two different
 * reasons. Going in: the draft is assembled in `Map` insertion order, which is argument
 * order, and rung 6 groups siblings by walking `accounts` — a canonical order there is
 * what makes its grouping (and so its renames) independent of which book came first.
 * Rung 5 above walks the same array to collect each type's top-level placeholders, but
 * its winner is argument-order-independent for a different reason: `betterRoot` is a
 * total order, so `reduce` picks the same winner no matter which book's copy the walk
 * meets first. What the canonical walk still fixes is the renames rung 6 then applies to
 * the children that reparenting hands it. That is all the pre-sort guarantees: rung 1
 * appends restored accounts behind it, so the arrays are no longer sorted by the time
 * every rung after the first runs. Coming out: the sort is what puts the merged book itself
 * in canonical order.
 */
function sortBook(book: Book): void {
  book.accounts.sort(byId);
  book.journal.sort(byId);
  book.budgets.sort((x, y) => compareStrings(budgetKeyOf(x), budgetKeyOf(y)));
  book.recurrences.sort(byId);
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

/**
 * One millisecond past `stamp`, or null when it will not parse — a record whose stamp is
 * unreadable came from outside the kernel, and the ladder invents nothing for it.
 *
 * The millisecond comes from the record rather than a clock so that `mergeBooks` stays
 * pure and its result stays a function of its two arguments alone.
 */
function oneTickPast(stamp: string): string | null {
  const at = Date.parse(stamp);
  return Number.isNaN(at) ? null : new Date(at + 1).toISOString();
}

/**
 * Stamp a record the ladder just rewrote one millisecond past the version it was
 * derived from. Mutates the record.
 *
 * A repair is a write, and last-writer-wins is the only channel this format has for
 * saying so. Left at its old stamp, a repaired record meets the device that still
 * holds the pre-repair one as an equally old claim, and the tie falls to whichever
 * body sorts higher — which can be the unrepaired one, undoing the repair. Worse, the
 * flip can change a field a later rung keyed off (a name the dedup rung rewrote sorts
 * ahead of the parentId the tie originally turned on), so the merge settles on a
 * different book each time two devices that already agree sync again.
 *
 * A rung only calls this where it actually changed something, so re-merging an
 * already-repaired book finds nothing to repair and stamps nothing.
 */
function repaired(record: { updatedAt: string }): void {
  // A record whose stamp will not parse came from outside the kernel; leave it be
  // rather than invent one. validateBook is what rejects it.
  const next = oneTickPast(record.updatedAt);
  if (next !== null) record.updatedAt = next;
}

/**
 * The records a rung still allows, with a tombstone written into `draft` for each one it
 * drops. Mutates `draft`; the caller assigns the survivors back.
 *
 * A drop is a delete, and — exactly as `repaired` argues for a rewrite — last-writer-wins
 * is the only channel this format has for saying so. Filtering the array and writing
 * nothing leaves the merged book with no claim on that key at all: neither the record nor
 * any trace of its removal. The next merge then re-decides the key from scratch, and when
 * one device holds a real tombstone for it — the one `later` discarded on a live/dead tie
 * in favour of the copy this rung has just dropped — that merge adopts the tombstone
 * outright and returns a different book. A sync round that should have settled instead
 * hands `bookFingerprint` a change and writes again.
 *
 * `deletedAt` is one millisecond past the dropped record's own stamp, which is what makes
 * the drop settle by outranking rather than by being re-derived: every copy of the record
 * still out there is stamped at `updatedAt` by definition, so the tombstone beats all of
 * them. A device that goes on to *edit* the record wins on merit, as last-writer-wins
 * intends, and the rung — if the account state still forbids the record — drops it again
 * one tick past that newer stamp.
 *
 * The cost is that the drop is permanent: a rule dropped because a concurrent edit left
 * its accounts in two currencies stays dropped once that currency is put back. That is
 * the intended reading. The record is already gone from every device that has synced
 * (the engine saves the merge result over the local book), so the behaviour it replaces
 * was not "it comes back when you fix the account" but "it comes back if some device
 * skipped the sync" — and re-creating it is a normal write, which clears the tombstone.
 *
 * Ordering: only rung 1 consumes tombstones, and only account ones, so a budget or
 * recurrence tombstone written below it is inert for the rest of the ladder. A future
 * rung that drops *accounts* this way must run after rung 1 for the same reason, or its
 * tombstone would be read straight back and the account resurrected.
 */
function keepValid<T extends AnyRecord>(
  draft: Book,
  kind: TombstoneKind,
  records: readonly T[],
  keyOf: (record: T) => string,
  valid: (record: T) => boolean,
): T[] {
  const kept: T[] = [];
  for (const record of records) {
    if (valid(record)) {
      kept.push(record);
      continue;
    }
    // An unparseable stamp leaves the tombstone on the record's own: `oneTickPast`
    // refuses to invent a date, and a recorded delete that ties is still better than a
    // record that vanishes. Such a book came from outside the kernel either way — a
    // stamp `validateBook` waves through because it only asks for a string. It then
    // carries that stamp into `deletedAt`, where `decodeEnvelope`'s canonical-timestamp
    // gate refuses it on the receiving device: the record used to disappear here and
    // take the bad stamp with it, and now the removal is recorded instead. A refusal
    // the user can see beats a book that syncs by quietly shedding what it cannot spell.
    const deletedAt = oneTickPast(record.updatedAt) ?? record.updatedAt;
    addTombstone(draft, kind, keyOf(record), record, deletedAt);
  }
  return kept;
}

/** What made a draft irreparable, for the refusal's `details`. The ladder refuses for
 * several structurally different reasons and the code alone does not say which. */
type RepairFailure = "childrenAndPostings" | "rootWithPostings" | "missingTombstone";

/** Deterministic repair of a merged draft. Mutates `draft`. Returns null when the draft
 * is repaired, or what made the conflict irreducible. */
function repair(
  draft: Book,
  restorable: Map<string, Account>,
  versions: Map<string, Account[]>,
): RepairFailure | null {
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
    for (const rule of draft.recurrences) {
      referenced.add(rule.fromAccountId);
      for (const line of rule.lines) referenced.add(line.toAccountId);
    }

    const missing = [...referenced].filter((id) => !live.has(id)).sort();
    if (missing.length === 0) break;
    for (const id of missing) {
      const stone = draft.tombstones.find((t) => t.kind === "account" && t.key === id);
      // unreachable from valid inputs; refuse rather than invent
      if (!stone) return "missingTombstone";
      // Whichever is newer, a live copy some device still holds or the snapshot the
      // tombstone carries — see `latestLiveAccounts`. Taking the live copy on sight
      // would drop a rename the deleting device made just before deleting, since the
      // other device's copy can predate it.
      //
      // Stamped past the delete it overrides, not past its own last edit: dropping
      // the tombstone is the only record this book keeps of the rejection, so a
      // restored record still carrying its pre-delete stamp loses to that same
      // tombstone the next time the deleting device syncs. The account would then die
      // a second time — and by then a later rung may have removed whatever referenced
      // it (rung 2 detaches a cycle member, which can be the very parent link that
      // justified the restore), so nothing brings it back.
      const snapshot = stone.record as Account;
      const live = restorable.get(id);
      const restored: Account = {
        ...structuredClone(live === undefined ? snapshot : newerAccount(live, snapshot)),
        updatedAt: stone.deletedAt,
      };
      repaired(restored);
      draft.accounts.push(restored);
      // A resurrected record must not leave its tombstone behind — that shadowing
      // is exactly what validateBook rejects.
      draft.tombstones = draft.tombstones.filter((t) => t !== stone);
    }
  }

  // No rung below rewrites the journal, so this is the posting set rungs 2 and 3 share.
  const posted = new Set(draft.journal.flatMap((e) => e.postings.map((p) => p.accountId)));

  // 2. Break parent cycles. `wouldCreateCycle` only ever sees one device's book, so
  //    moving G1 under G2 here while G2 moves under G1 there is legal on both and a
  //    cycle only exists after the union. Nothing is lost by detaching — one parentId
  //    changes, no record disappears — so this is repaired, not refused. Runs before the
  //    rungs below because a cycle hides its members from the type cascade entirely, and
  //    because the mutual parenthood it invents would otherwise read as a genuine
  //    children-and-postings conflict in rung 3.
  //
  //    Which member is cut loose matters for whether rung 3 then refuses. Detaching
  //    clears the member's parent but not its child link — the member that pointed at it
  //    inside the cycle still does — so cutting loose an account that holds postings
  //    hands rung 3 exactly the children-and-postings pair it calls irreducible, and a
  //    cycle that was perfectly repairable fails the whole merge. Prefer a member no
  //    entry posts to; among the candidates the lowest id wins, which keeps the choice
  //    deterministic and the same in either argument order. When every member is posted
  //    to there is no such choice and rung 3 is right to refuse.
  //    Each pass clears one parentId, so the loop is bounded by the account count.
  //
  //    Two phases. The loop cuts every cycle exactly as before; the phase below then gives
  //    each cut-loose member a parent again. They are separate because the loop's bound is
  //    "each pass clears one parentId" — an attach inside it would feed the next findCycle
  //    pass and lose that argument. The loop runs to completion first, and the phase then
  //    attaches only to parents the member cannot reach, so the forest stays a forest.
  const cutLoose = new Map<string, Set<string>>();
  for (;;) {
    const index = new Map(draft.accounts.map((a) => [a.id, a]));
    const cycle = findCycle(draft.accounts, index);
    if (cycle === null) break;
    const free = cycle.filter((id) => !posted.has(id));
    const candidates = free.length > 0 ? free : cycle;
    const lowest = candidates.reduce((low, id) => (id < low ? id : low));
    const detached = index.get(lowest);
    if (detached === undefined) break; // cycle ids come from index; unreachable
    detached.parentId = null;
    repaired(detached);
    cutLoose.set(lowest, new Set(cycle));
  }

  //    Parking a member at the top level is a last resort, not the repair. An account left
  //    there is a fifth category root the user cannot move back — `updateAccount` refuses any
  //    move between the top level and a parent — and the root-collapse rung below would
  //    dissolve it into the type's root, tombstoning a group somebody made. `id` order, so
  //    two members cut loose in one repair are re-attached in the same sequence whichever
  //    book was merged first. The member is stamped twice, once per change; the second stamp
  //    is what the other device's copy of the re-attachment has to beat.
  for (const id of [...cutLoose.keys()].sort()) {
    const member = draft.accounts.find((a) => a.id === id);
    if (member === undefined) continue; // nothing removes accounts here; unreachable
    const parentId = reattachTarget(
      draft,
      member,
      cutLoose.get(id) as Set<string>,
      versions,
      posted,
    );
    if (parentId === null) continue;
    member.parentId = parentId;
    repaired(member);
  }

  // 3. Placeholder consistency: children force it on; postings force it off; both is irreducible.
  //
  //    So is a top-level account with postings. Forcing it off placeholder would leave a
  //    top-level leaf, which validateBook rejects (a top-level account is a category root),
  //    and the other way out — hanging it under a parent — needs a parent the ladder does
  //    not have: in the draft the account has none. BL-048 added that re-attachment, but in
  //    rung 2 rather than here, so what reaches this check either came in already parked on
  //    purpose or from outside the kernel, and refusing sends the sync engine a conflict the
  //    user resolves (SYNC_MERGE_CONFLICT) instead of a merged book that will not load.
  //
  //    This shape is rarer after BL-048, not impossible: rung 2's re-attachment can itself
  //    leave a member parked, when the draft holds no placeholder root of its type to hand it
  //    back to, and its detach loop can still cut loose a member that holds postings when every
  //    member of a cycle does — either can land an account here with postings and no parent.
  //    Commands alone still cannot set it up directly: updateAccount keeps every account at
  //    the level it was created at and refuses a top-level leaf outright, so besides rung 2's
  //    own park this reaches the kernel only from an import or a hand-edited file. Either way
  //    the check guards the same invariant validateBook does, and the alternative to refusing
  //    is a merged book that will not load.
  //
  //    Checked after children-and-postings, so an account that is both is still refused
  //    for that. Accounts are visited in the draft's order, which does not depend on which
  //    book came first, so when several would refuse, both argument orders name the same
  //    one.
  const withChildren = new Set(
    draft.accounts.filter((a) => a.parentId !== null).map((a) => a.parentId as string),
  );
  for (const account of draft.accounts) {
    const hasChild = withChildren.has(account.id);
    const hasPosting = posted.has(account.id);
    if (hasChild && hasPosting) return "childrenAndPostings";
    if (hasPosting && account.parentId === null) return "rootWithPostings";
    if (hasChild && !account.isPlaceholder) {
      account.isPlaceholder = true;
      repaired(account);
    }
    if (hasPosting && account.isPlaceholder) {
      account.isPlaceholder = false;
      repaired(account);
    }
  }

  // 4. Cascade parent types down mismatched descendants (top-down, deterministic order).
  //    `seen` is redundant now that rung 2 leaves a forest behind — it stays so that a
  //    regression there surfaces as a wrong account type rather than a stack overflow.
  const seen = new Set<string>();
  const cascade = (parent: Account) => {
    for (const child of draft.accounts.filter((a) => a.parentId === parent.id).sort(byId)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      if (child.type !== parent.type) {
        child.type = parent.type;
        repaired(child);
      }
      cascade(child);
    }
  };
  for (const root of draft.accounts.filter((a) => a.parentId === null).sort(byId)) {
    seen.add(root.id);
    cascade(root);
  }

  // 5. One top-level placeholder per account type. Two live ones of a type mean the same
  //    category root arriving from two devices: `createHousehold` is the only code that
  //    creates a top-level account — `addAccount` requires a parent — and it marks all four
  //    roots placeholders, so the shape has no other origin in a book this app produced.
  //    Since BL-080 the kernel says the rest of it: a top-level account must be a
  //    placeholder, refused by `createAccount`, `updateAccount` and `validateBook` alike, and
  //    no edit moves an account between the top level and a parent. The `isPlaceholder`
  //    clause below is therefore a guard on the draft rather than a filter on real books:
  //    rung 3 forces the flag only where a child requires it or a posting forbids it, and a
  //    member rung 2's last resort parks here childless and unposted trips neither, so it can
  //    still reach this point carrying whatever flag it had before it was cut loose.
  //
  //    Ordering: after rung 1, because this drops accounts through `keepValid` and rung 1 is
  //    the only consumer of account tombstones — earlier, and rung 1 would read the tombstone
  //    straight back and resurrect the root. Before the dedup rung, because reparenting is
  //    what creates the sibling-name clashes that rung exists to resolve; after it, the
  //    clashes survive into a result `validateBook` rejects.
  const roots = new Map<Account["type"], Account[]>();
  for (const account of draft.accounts) {
    if (account.parentId !== null || !account.isPlaceholder) continue;
    if (account.id.startsWith("sys:")) continue;
    roots.set(account.type, [...(roots.get(account.type) ?? []), account]);
  }
  // Loser id -> winner id. A map rather than a set of losers because the budget
  // repointing below needs to know *where* to send a limit, not just that its account
  // is going away.
  const rootWinner = new Map<string, string>();
  for (const group of roots.values()) {
    if (group.length < 2) continue;
    const winner = group.reduce(betterRoot);
    for (const loser of group) {
      if (loser === winner) continue;
      rootWinner.set(loser.id, winner.id);
      for (const child of draft.accounts) {
        if (child.parentId !== loser.id) continue;
        child.parentId = winner.id;
        repaired(child);
      }
    }
  }
  draft.accounts = keepValid(
    draft,
    "account",
    draft.accounts,
    (account) => account.id,
    (account) => !rootWinner.has(account.id),
  );

  //    A budget follows its account exactly as a child does. Nothing forbids one on a
  //    top-level placeholder — `setBudget` and `validateBook` both refuse only
  //    `type !== "expense"`, not a placeholder — so a limit can legally sit directly on
  //    a category root, and rung 7 below would otherwise drop it for the wrong reason:
  //    not because it stopped covering an expense account, but because its account just
  //    disappeared out from under it.
  //
  //    A budget's key is its own account id, period and currency — unlike an account,
  //    which keeps a stable id no matter where it moves, relocating a budget changes its
  //    key outright. So this is a vacate-and-recreate, not a field edit in place: first
  //    every budget on a loser is dropped through `keepValid`, exactly as any other rung
  //    drops a record, which tombstones it at the key it is actually leaving — the loser
  //    account's own — so a device that still holds that key does not hand it back on
  //    the next sync.
  //
  //    Only then is a moved copy considered for the winner's key, which can already be
  //    occupied two different ways — both real: the winner's own account can have had a
  //    budget of its own before this merge, live or (`removeBudget`) deleted. A live one
  //    is resolved by keeping the newer of the two by `later`'s own convention
  //    (`newerBudget`) — greater `updatedAt`, then the canonically greater body — and
  //    dropping the other, needing no tombstone of its own since its key was already
  //    vacated above. A dead one is exactly as much a claim on that key as a live budget
  //    is: pushing `moved` on top of it unconditionally is what `validateBook` calls a
  //    tombstone shadowing a live record, and the claims union at the top of `mergeBooks`
  //    would undo the push on the very next merge regardless, since a dead and
  //    a live claim for the same key there resolve by the same rule. So this weighs
  //    `moved` against the tombstone with `later` too: the tombstone wins outright if
  //    it is newer (`moved` is dropped — its own key already carries the record of its
  //    going), and otherwise `moved` wins, clearing the tombstone before it is pushed —
  //    exactly what a fresh `setBudget` does when it resurrects a budget over one a
  //    tombstone still names.
  const relocated = draft.budgets.filter((b) => rootWinner.has(b.accountId));
  draft.budgets = keepValid(
    draft,
    "budget",
    draft.budgets,
    budgetKeyOf,
    (b) => !rootWinner.has(b.accountId),
  );
  for (const budget of relocated) {
    const moved: Budget = {
      ...structuredClone(budget),
      accountId: rootWinner.get(budget.accountId) as string,
    };
    repaired(moved);
    const key = budgetKeyOf(moved);
    const tombstone = draft.tombstones.find((t) => t.kind === "budget" && t.key === key);
    if (tombstone !== undefined) {
      const verdict = later(
        { alive: false, at: tombstone.deletedAt, stone: tombstone },
        { alive: true, at: moved.updatedAt, record: moved },
      );
      if (verdict.alive) {
        clearTombstone(draft, "budget", key);
        draft.budgets.push(moved);
      }
      continue;
    }
    const incumbentIndex = draft.budgets.findIndex((b) => budgetKeyOf(b) === key);
    if (incumbentIndex === -1) {
      draft.budgets.push(moved);
    } else if (newerBudget(draft.budgets[incumbentIndex], moved) === moved) {
      draft.budgets[incumbentIndex] = moved;
    }
  }

  // 6. Deduplicate sibling names: canonically greatest record keeps the name. The slot
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
      repaired(ordered[i]);
    }
  }

  // 7. A budget only makes sense on an expense account. Two rungs above have already
  //    dealt with a budget's account disappearing: rung 1 restores one deleted on the
  //    other device, and rung 5 relocates one that sat directly on a root the collapse
  //    absorbed, onto the surviving root. So a budget's account is never simply missing
  //    by the time this runs, and what this drops is exactly the limits whose account is
  //    not an expense — ordinarily one a concurrent edit retyped away from it — each one
  //    tombstoned by `keepValid`, which is what keeps the merge idempotent.
  const typeById = new Map(draft.accounts.map((a) => [a.id, a.type]));
  draft.budgets = keepValid(
    draft,
    "budget",
    draft.budgets,
    budgetKeyOf,
    (b) => typeById.get(b.accountId) === "expense",
  );

  // 8. A recurrence is only postable while every account it touches is not a placeholder
  //    and they all share one currency. Rung 1 has restored the accounts, so this drops
  //    exactly the rules a concurrent retype-to-placeholder or currency change made
  //    impossible — the same treatment, tombstone included, rung 7 gives a budget whose
  //    account stopped being an expense.
  const accountById = new Map(draft.accounts.map((a) => [a.id, a]));
  draft.recurrences = keepValid(
    draft,
    "recurrence",
    draft.recurrences,
    (rule) => rule.id,
    (rule) => {
      const involved = [rule.fromAccountId, ...rule.lines.map((line) => line.toAccountId)];
      const currencies = new Set<string>();
      for (const id of involved) {
        const account = accountById.get(id);
        if (!account || account.isPlaceholder) return false;
        currencies.add(account.currency);
      }
      return currencies.size === 1;
    },
  );

  return null;
}

function accountIndex(book: Book): Map<string, Account> {
  return new Map(book.accounts.map((account) => [account.id, account]));
}

/** Which of an account's two meaning-bearing fields moved under an entry. */
type MeaningBreak = "currency" | "accountType";

/**
 * Null while every entry still means what the device that holds it recorded, else what
 * broke.
 *
 * Two account fields carry an entry's meaning, and both change under the same
 * precondition — legal on a device where the account has no postings (and, for `type`,
 * no children), while the other device posts to it. Neither shows up in the postings
 * themselves, which record only an account id, so the union reinterprets silently and
 * validateBook stays green:
 *
 * - currency: 100 entered as ILS reads back as 100 USD. With `fx` in play it breaks
 *   loudly instead (ENTRY_FX_RATE_MISMATCH).
 * - type: an expense leaf retyped to income turns "money spent" into "money received"
 *   in every report, since Dashboard, Stats and Budget all classify by the account's
 *   current type.
 *
 * Neither is repairable — which currency, or which side of the ledger, the amount meant
 * is not recoverable from the merge — so both are refused rather than patched.
 *
 * Compared per posting-account rather than over the entry's multiset of currencies or
 * types: two accounts swapping values inside one entry leaves the multiset identical
 * while inverting what the entry says. A source that never knew an account says nothing
 * about it.
 *
 * Both books are checked the same way, and a currency break anywhere outranks a type
 * break anywhere, so the verdict — reason included — is the same in either argument
 * order.
 */
function entryMeaningBroken(draft: Book, sources: readonly Book[]): MeaningBreak | null {
  const after = accountIndex(draft);
  let retyped = false;
  for (const source of sources) {
    const before = accountIndex(source);
    const carried = new Set(source.journal.map((entry) => entry.id));
    for (const entry of draft.journal) {
      if (!carried.has(entry.id)) continue;
      for (const posting of entry.postings) {
        const was = before.get(posting.accountId);
        if (was === undefined) continue;
        // `now` is undefined only if rung 1 failed to restore a posted-to account, which
        // it cannot; an absent account still counts as a break rather than as agreement.
        const now = after.get(posting.accountId);
        if (was.currency !== now?.currency) return "currency";
        if (was.type !== now?.type) retyped = true;
      }
    }
  }
  return retyped ? "accountType" : null;
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
    schemaVersion: 3,
    name: meta.name,
    homeCurrency: meta.homeCurrency,
    metaUpdatedAt: meta.metaUpdatedAt,
    accounts: [],
    journal: [],
    budgets: [],
    recurrences: [],
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
    } else if (kind === "budget") {
      draft.budgets.push(structuredClone(claim.record) as Budget);
    } else if (kind === "recurrence") {
      draft.recurrences.push(structuredClone(claim.record) as Recurrence);
    } else {
      // `kind` is derived from a string slice and cast, so tsc cannot flag a missing
      // branch above the way it can an exhaustive switch — but it can flag this one:
      // the four checks above narrow `kind` to `never` here as long as `TombstoneKind`
      // stays a four-member union, so a fifth member fails `tsc --noEmit` right on this
      // line rather than compiling into the silent-miscategorization bug Task 2 closed
      // for `recurrence` (a claim of the new kind filed into `draft.recurrences` as a
      // structurally invalid record, then quietly dropped by whichever repair rung
      // notices first). Unreachable from any data today; reachable only by a future
      // `TombstoneKind` widening, and it is that future task's own build and tests that
      // hit it — not a user's sync.
      const exhaustive: never = kind;
      throw new Error(`mergeBooks: unhandled live claim kind "${String(exhaustive)}"`);
    }
  }

  sortBook(draft);
  // `reason` names which of the refusals this is. The code is the same for all of them, so
  // without it a caller — or the symmetry property, which compares the whole error —
  // cannot tell an order-dependent choice *between* the reasons from agreement.
  const unrepaired = repair(draft, latestLiveAccounts([a, b]), accountVersions([a, b]));
  if (unrepaired !== null) {
    return err("SYNC_MERGE_CONFLICT", "Books conflict beyond automatic repair", {
      reason: unrepaired,
    });
  }
  // Runs on the repaired draft: rung 1 decides which accounts are live at all, and rung 4
  // can retype one, so both are what fix each posting's currency and type.
  const broken = entryMeaningBroken(draft, [a, b]);
  if (broken !== null) {
    return err(
      "SYNC_MERGE_CONFLICT",
      broken === "currency"
        ? "An account currency changed under an entry posted on the other device"
        : "An account type changed under an entry posted on the other device",
      { reason: broken },
    );
  }
  sortBook(draft);
  return ok(draft);
}

/** Order-insensitive content identity: two books with the same records compare equal
 * even when their arrays are in different insertion orders (command output vs merge
 * output). The engine uses it to decide "did anything actually change". */
export function bookFingerprint(book: Book): string {
  const sorted: Book = {
    ...book,
    accounts: [...book.accounts].sort(byId),
    journal: [...book.journal].sort(byId),
    budgets: [...book.budgets].sort((x, y) =>
      compareStrings(budgetKeyOf(x), budgetKeyOf(y)),
    ),
    recurrences: [...book.recurrences].sort(byId),
    tombstones: [...book.tombstones].sort((x, y) =>
      compareStrings(`${x.kind}|${x.key}`, `${y.kind}|${y.key}`),
    ),
  };
  return canonicalJson(sorted);
}
