import fc from "fast-check";
import { createAccount, deleteAccount, updateAccount } from "../../src/kernel/accounts";
import { removeBudget, setBudget } from "../../src/kernel/budgets";
import { createBook } from "../../src/kernel/create-book";
import { deleteEntry, postEntry } from "../../src/kernel/journal";
import { mergeBooks } from "../../src/kernel/merge";
import { createRecurrence, deleteRecurrence, updateRecurrence } from "../../src/kernel/recurrences";
import type { Result } from "../../src/kernel/result";
import { budgetKeyOf } from "../../src/kernel/tombstones";
import type { AccountType, Book, CurrencyCode } from "../../src/kernel/types";
import { validateBook } from "../../src/kernel/validate";
import { unwrap } from "../helpers";

/**
 * Deterministic ids, so a printed counterexample can actually be replayed.
 *
 * Real ULIDs would hand every run — and every shrink step inside one failing run —
 * a fresh set of ids, and account id is what the merge's tie-breaks and its
 * cycle-detach rung sort on. A counterexample found under one set of ids would then
 * not reproduce under the next, which is what makes `{ seed }` replay in Step 3 of
 * the brief worth having.
 *
 * The counter is scrambled rather than used raw: a plain counter would give device A
 * (forked first) ids that always sort before device B's, so every id-ordered decision
 * in `merge.ts` would only ever be exercised from one side. The mix is a bijection on
 * uint32, so ids stay unique.
 */
const ids = vi.hoisted(() => ({ next: 0 }));
vi.mock("../../src/kernel/ids", () => ({
  createId: (): string => {
    ids.next += 1;
    const mixed = Math.imul(ids.next, 2654435761) >>> 0;
    return `ID${((mixed ^ (mixed >>> 13)) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
  },
}));

const T = (n: number) =>
  `2026-09-02T10:00:${String(n % 60).padStart(2, "0")}.${String(n % 1000).padStart(3, "0")}Z`;

/** One randomly parameterised command application. Invalid applications are skipped
 * (the command returns err and the book is left unchanged), which mirrors real use:
 * devices only ever hold books that valid command sequences produced. */
type OpTag =
  | "create"
  | "rename"
  | "reparent"
  | "retype"
  | "currency"
  | "placeholder"
  | "deleteAcc"
  | "post"
  | "deleteEntry"
  | "budget"
  | "unbudget"
  | "addRule"
  | "editRule"
  | "deleteRule";

type Op = {
  tag: OpTag;
  x: number;
  y: number;
  t: number;
  name: string;
  currency: CurrencyCode;
  type: AccountType;
};

/**
 * Weights are repeats in the list. Each op is here to make one part of the merge
 * reachable; the ones that need to fire on *both* devices in the same scenario are
 * repeated, because a conflict needs two independent draws to line up:
 *
 * - create x2    new records on one side only (the plain union), and two devices
 *                creating the same name under the same inherited parent, which is
 *                what the sibling-rename rung repairs.
 * - rename x1    two devices editing the same record: last-writer-wins, plus more
 *                duplicate sibling names.
 * - reparent x3  the only route to a parent cycle. `wouldCreateCycle` only sees one
 *                device's book, so "A moves G1 under G2" and "B moves G2 under G1"
 *                are each legal alone and only collide in the union. Needs a
 *                reparent on both sides picking the reversed pair, hence x3.
 * - retype x2    the only route to a parent/child type mismatch (type-cascade rung)
 *                and to a budget whose account stopped being an expense (budget-drop
 *                rung). Legal only on a childless, postingless account.
 * - currency x3  the other cross-device reinterpretation: legal on a device with no
 *                postings on the account, while the other device posts to it. Merging
 *                would silently reread 100 ILS as 100 USD, so it must be refused.
 *                x3 because it has to beat the "no postings yet" precondition.
 * - placeholder x2  the only route to the placeholder rung: a group on one device and
 *                a postable leaf on the other. When the group also gained a child and
 *                the leaf a posting, no repair exists and the merge must refuse.
 * - deleteAcc x1 tombstones, and the restore-from-tombstone rung when the other side
 *                still references the account.
 * - post x2      postings: the placeholder-vs-postings conflict, and the other half
 *                of the currency scenario.
 * - deleteEntry, budget, unbudget x1 each — journal and budget tombstones.
 * - addRule x1   new rules on one side only (the plain union). Unlike `create`, two
 *                independent draws can never collide on the same rule the way two
 *                `create`s can collide on the same sibling name: `createRecurrence`
 *                mints a fresh id every time, and ids are drawn from one counter that
 *                keeps advancing across both devices' op sequences (never reset between
 *                them — only once per scenario, before device A's sequence runs), so
 *                two draws are never the same id.
 * - editRule, deleteRule x1 each — always resolve against `seedBook`'s one pre-existing
 *                rule until an `addRule` has fired, which is what lets both devices'
 *                sequences edit or delete *the same* rule id — the only route to the
 *                recurrence last-writer-wins tie-break, including the equal-stamp one,
 *                and to the restore-from-tombstone rung when one device deletes an
 *                account the rule still references (`deleteAcc` already reaches that
 *                account by cycling through `book.accounts`, same as it does for
 *                budgets and postings).
 */
const OP_TAGS: OpTag[] = [
  "create",
  "create",
  "rename",
  "reparent",
  "reparent",
  "reparent",
  "retype",
  "retype",
  "currency",
  "currency",
  "currency",
  "placeholder",
  "placeholder",
  "deleteAcc",
  "post",
  "post",
  "deleteEntry",
  "budget",
  "unbudget",
  "addRule",
  "editRule",
  "deleteRule",
];

const arbOp: fc.Arbitrary<Op> = fc.record({
  tag: fc.constantFrom(...OP_TAGS),
  x: fc.nat(20),
  y: fc.nat(20),
  // Both devices draw stamps from one small domain, so the same record can be edited
  // at the same instant on both sides. That is the only way to reach the equal-stamp
  // tie-break in `later()` — the tie-break that makes the merge order-independent, and
  // where the subtlest failures live. Kept deliberately narrow: widening it thins the
  // collisions out and buys nothing, since unequal stamps are the easy path.
  t: fc.nat(6),
  name: fc.constantFrom("Food", "Rent", "Fun", "Daily", "Assets", "Cash 2"),
  // A small pool so two devices actually collide on the same code.
  currency: fc.constantFrom("ILS", "USD", "EUR"),
  type: fc.constantFrom("asset", "liability", "equity", "income", "expense"),
});

function pick<Item>(items: Item[], index: number): Item | undefined {
  return items.length === 0 ? undefined : items[index % items.length];
}

/** `null` means the op had no target on this device, so nothing happens. */
function applyOp(book: Book, op: Op): Book {
  const at = T(op.t);
  const leaves = book.accounts.filter((a) => !a.isPlaceholder);
  const groups = book.accounts.filter((a) => a.isPlaceholder);
  const expenses = leaves.filter((a) => a.type === "expense");
  const assets = leaves.filter((a) => a.type === "asset");
  const run = (): Result<Book> | null => {
    switch (op.tag) {
      case "create": {
        const parent = pick(groups, op.x);
        return createAccount(
          book,
          {
            parentId: parent?.id ?? null,
            name: op.name,
            type: parent?.type ?? "expense",
            currency: op.currency,
            isPlaceholder: op.y % 3 === 0,
          },
          at,
        );
      }
      case "rename": {
        const target = pick(book.accounts, op.x);
        if (!target) return null;
        return updateAccount(book, { id: target.id, name: `${op.name} ${op.y % 3}` }, at);
      }
      case "reparent": {
        // Groups are targets too, not just leaves: only a group can be a parent, so
        // only a group-under-group move can close a cycle across two devices.
        const target = pick(book.accounts, op.x);
        const parent = pick(groups, op.y);
        if (!target || !parent) return null;
        return updateAccount(book, { id: target.id, parentId: parent.id }, at);
      }
      case "retype": {
        const target = pick(book.accounts, op.x);
        if (!target) return null;
        return updateAccount(book, { id: target.id, type: op.type }, at);
      }
      case "currency": {
        const target = pick(book.accounts, op.x);
        if (!target) return null;
        return updateAccount(book, { id: target.id, currency: op.currency }, at);
      }
      case "placeholder": {
        const target = pick(book.accounts, op.x);
        if (!target) return null;
        return updateAccount(book, { id: target.id, isPlaceholder: op.y % 2 === 0 }, at);
      }
      case "deleteAcc": {
        const target = pick(book.accounts, op.x);
        if (!target) return null;
        return deleteAccount(book, target.id, at);
      }
      case "post": {
        const from = pick(assets, op.x);
        const to = pick(expenses, op.y);
        if (!from || !to || from.id === to.id) return null;
        return postEntry(
          book,
          {
            date: "2026-01-10",
            description: op.name,
            postings: [
              { accountId: to.id, side: "debit", amount: 100 + op.y },
              { accountId: from.id, side: "credit", amount: 100 + op.y },
            ],
          },
          at,
        );
      }
      case "deleteEntry": {
        const entry = pick(book.journal, op.x);
        if (!entry) return null;
        return deleteEntry(book, entry.id, at);
      }
      case "budget": {
        const target = pick(expenses, op.x);
        if (!target) return null;
        return setBudget(
          book,
          {
            accountId: target.id,
            period: op.y % 2 === 0 ? "month" : "year",
            currency: op.currency,
            limit: 100 + op.y,
          },
          at,
        );
      }
      case "unbudget": {
        const budget = pick(book.budgets, op.x);
        if (!budget) return null;
        return removeBudget(
          book,
          { accountId: budget.accountId, period: budget.period, currency: budget.currency },
          at,
        );
      }
      case "addRule": {
        const from = pick(leaves, op.x);
        const to = pick(leaves, op.y);
        if (!from || !to || from.id === to.id) return null;
        return createRecurrence(
          book,
          {
            description: op.name,
            fromAccountId: from.id,
            lines: [{ toAccountId: to.id, amount: 100 + op.y }],
            every: 1,
            unit: "month",
            startDate: "2026-01-10",
            endDate: null,
          },
          at,
        );
      }
      case "editRule": {
        const target = pick(book.recurrences, op.x);
        if (!target) return null;
        return updateRecurrence(
          book,
          {
            id: target.id,
            description: `${op.name} ${op.y % 3}`,
            fromAccountId: target.fromAccountId,
            lines: target.lines,
            every: target.every,
            unit: target.unit,
            startDate: target.startDate,
            endDate: target.endDate,
          },
          at,
        );
      }
      case "deleteRule": {
        const target = pick(book.recurrences, op.x);
        if (!target) return null;
        return deleteRecurrence(book, target.id, at);
      }
    }
  };
  const result = run();
  return result !== null && result.ok ? result.value : book;
}

/**
 * The chart both devices already had when they last agreed.
 *
 * `Daily` and `Trips` are two placeholders of the same type under the same parent:
 * a pair that each device may legally move under the other. `Misc` is a childless
 * root group and `Other` a childless root leaf — a root has no parent type to match,
 * so those two are the accounts a `retype` can actually land on.
 *
 * The one pre-existing rule (Cash -> Food) exists for the same reason the accounts do:
 * `editRule`/`deleteRule` need a shared id to collide on, and only a record both device
 * forks already held before diverging can supply one — `addRule` alone never can, since
 * every id it mints is fresh (see the `OP_TAGS` comment above).
 */
function seedBook(): Book {
  let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, T(0)));
  const add = (
    parentId: string | null,
    name: string,
    type: AccountType,
    isPlaceholder: boolean,
  ) => {
    book = unwrap(
      createAccount(book, { parentId, name, type, currency: "ILS", isPlaceholder }, T(0)),
    );
    return book.accounts[book.accounts.length - 1].id;
  };
  const assetsId = add(null, "Assets", "asset", true);
  const cashId = add(assetsId, "Cash", "asset", false);
  const expensesId = add(null, "Expenses", "expense", true);
  const foodId = add(expensesId, "Food", "expense", false);
  add(expensesId, "Daily", "expense", true);
  add(expensesId, "Trips", "expense", true);
  add(null, "Misc", "expense", true);
  add(null, "Other", "expense", false);
  book = unwrap(
    createRecurrence(
      book,
      {
        description: "Groceries",
        fromAccountId: cashId,
        lines: [{ toAccountId: foodId, amount: 100 }],
        every: 1,
        unit: "month",
        startDate: "2026-01-01",
        endDate: null,
      },
      T(0),
    ),
  );
  return book;
}

/**
 * Both devices fork from one common ancestor, so they hold the *same* record ids and
 * their edits can actually conflict. Forking from two separate `seedBook()` calls
 * would give the two books disjoint ids, and the merge would degenerate into a union
 * of two unrelated books — no last-writer-wins, no cycle, no currency clash.
 */
const SEED = seedBook();

function fork(ops: Op[]): Book {
  let book = structuredClone(SEED);
  for (const op of ops) book = applyOp(book, op);
  return book;
}

/** Violations rather than a bare `false`, so a failure names the missing repair. */
function violations(book: Book): unknown {
  const verdict = validateBook(book);
  return verdict.ok ? [] : verdict.error.details?.violations;
}

/** The two account fields a posting resolves through without naming either. */
const MEANING_FIELDS = ["currency", "type"] as const;

/**
 * Postings whose account reads differently than it did on a device that recorded the
 * entry — 100 entered as ILS coming back as 100 USD, or a spend coming back filed as
 * income.
 *
 * Nothing structural breaks when that happens, so `validateBook` stays green and the
 * merge still converges: this is the one invariant the other properties cannot see.
 * Changing either field is legal on a device with no postings on the account, and
 * posting to it is legal on a device that never changed it, so only the union can
 * produce it — and neither which currency nor which side of the ledger the amount meant
 * is recoverable afterwards. `mergeBooks` therefore has to refuse rather than return
 * such a book.
 */
function reinterpreted(merged: Book, sources: readonly Book[]): string[] {
  const now = new Map(merged.accounts.map((account) => [account.id, account]));
  const found: string[] = [];
  for (const source of sources) {
    const carried = new Set(source.journal.map((entry) => entry.id));
    const then = new Map(source.accounts.map((account) => [account.id, account]));
    for (const entry of merged.journal) {
      if (!carried.has(entry.id)) continue;
      for (const posting of entry.postings) {
        const before = then.get(posting.accountId);
        const after = now.get(posting.accountId);
        if (before === undefined || after === undefined) continue;
        for (const field of MEANING_FIELDS) {
          if (before[field] !== after[field]) {
            found.push(
              `${entry.id} ${posting.accountId} ${field}: ${before[field]} -> ${after[field]}`,
            );
          }
        }
      }
    }
  }
  return found;
}

/** `kind|key` of every live record in a book, the same scheme `merge.ts`'s own
 * `liveClaims` keys claims by. */
function liveRecordKeys(book: Book): Set<string> {
  const keys = new Set<string>();
  for (const account of book.accounts) keys.add(`account|${account.id}`);
  for (const entry of book.journal) keys.add(`entry|${entry.id}`);
  for (const budget of book.budgets) keys.add(`budget|${budgetKeyOf(budget)}`);
  for (const rule of book.recurrences) keys.add(`recurrence|${rule.id}`);
  return keys;
}

function tombstoneKeys(book: Book): Set<string> {
  return new Set(book.tombstones.map((t) => `${t.kind}|${t.key}`));
}

/**
 * Keys that were live in a source and came back neither live nor tombstoned — records
 * the merge made disappear leaving no claim behind. Keys rather than a bare `false`, so
 * a failure names the record.
 *
 * `mergeBooks`'s claim-dispatch loop files every input key as either live or a tombstone
 * before the repair ladder runs, and no rung removes a record without writing the
 * tombstone that says so, so this is empty by construction. It is the property the
 * merge's convergence rests on: a key with no claim at all is one the next merge with
 * either source re-decides from scratch, which is how BL-037 turned a repair-rung drop
 * into a merge that was not a no-op the second time round.
 */
function vanished(inputs: readonly Book[], output: Book): string[] {
  const outputLive = liveRecordKeys(output);
  const outputDead = tombstoneKeys(output);
  return inputs.flatMap((input) =>
    [...liveRecordKeys(input)].filter((key) => !outputLive.has(key) && !outputDead.has(key)),
  );
}

describe("mergeBooks properties", () => {
  it("merge of two forked histories validates, symmetrically, and converges", () => {
    fc.assert(
      fc.property(
        fc.array(arbOp, { maxLength: 12 }),
        fc.array(arbOp, { maxLength: 12 }),
        (opsA, opsB) => {
          ids.next = 1000; // same inputs => same ids, so a counterexample replays
          const a = fork(opsA);
          const b = fork(opsB);
          const ab = mergeBooks(a, b);
          const ba = mergeBooks(b, a);
          expect(ab.ok).toBe(ba.ok);
          if (!ab.ok || !ba.ok) {
            // Refusing is a legitimate outcome — but only for the one code, and only if
            // both argument orders agree. The whole error is compared, not just the
            // code: mergeBooks refuses for two structurally distinct reasons, so an
            // order-dependent choice *between* them would otherwise pass unnoticed.
            if (!ab.ok) expect(ab.error.code).toBe("SYNC_MERGE_CONFLICT");
            if (!ba.ok) expect(ba.error.code).toBe("SYNC_MERGE_CONFLICT");
            if (!ab.ok && !ba.ok) expect(ab.error).toEqual(ba.error);
            return;
          }
          expect(ab.value).toEqual(ba.value);
          expect(violations(ab.value)).toEqual([]);
          // Having returned a book rather than refusing, it must be one whose entries
          // still mean what the devices recorded.
          expect(reinterpreted(ab.value, [a, b])).toEqual([]);
          // Every record either survived or left a tombstone. Checked before the
          // convergence assertions below rather than after, because a vanished key is
          // exactly what makes them fail (BL-037) and this names the record they would
          // only report as a whole-book diff.
          expect(vanished([a, b], ab.value)).toEqual([]);
          // Idempotence and convergence: replaying the merge, or re-merging either
          // source into the result, must be a no-op.
          expect(unwrap(mergeBooks(ab.value, ab.value))).toEqual(ab.value);
          expect(unwrap(mergeBooks(ab.value, a))).toEqual(ab.value);
          expect(unwrap(mergeBooks(ab.value, b))).toEqual(ab.value);
        },
      ),
      // ~0.55ms a scenario, so this is the share of the run the whole suite can
      // afford: it keeps this file near a second against the project's ~1.6s. Each
      // `npm test` draws a fresh fast-check seed, so the ground covered accumulates
      // across runs rather than being fixed at this number.
      { numRuns: 2000 },
    );
    // Well clear of the 1.1s this takes here, so a slower machine reports a real
    // failure rather than a timeout.
  }, 30_000);

  it("merging two independent onboardings is conflict-free", () => {
    fc.assert(
      fc.property(fc.array(arbOp, { maxLength: 8 }), (ops) => {
        ids.next = 1000;
        const a = fork(ops);
        const b = seedBook(); // fresh device: different ids for the same seed names
        const merged = mergeBooks(a, b);
        expect(merged.ok).toBe(true);
        if (merged.ok) expect(violations(merged.value)).toEqual([]);
      }),
      { numRuns: 750 },
    );
  }, 30_000);
});
