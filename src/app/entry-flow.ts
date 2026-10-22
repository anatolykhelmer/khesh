import { journalScope } from "../kernel";
import type { Book, JournalEntry } from "../kernel";
import { formatSignedMinor } from "./format";

export type FlowTone = "pos" | "neg" | "none";
export type EntryFlow = { tone: FlowTone; text: string };

/**
 * The accounts a journal row's amount is signed against. Unfiltered, that is net worth:
 * every asset and liability. Filtered by an asset or liability, it is that account and its
 * subtree — the kernel's own `journalScope`, so a group means exactly what the filter does.
 * Filtered by income, expense or equity it is empty, and every row keeps today's display:
 * "your position grew" has no meaning for a category.
 */
export function flowScope(book: Book, accountId: string | undefined): Set<string> {
  if (accountId === undefined) {
    return new Set(
      book.accounts.filter((a) => a.type === "asset" || a.type === "liability").map((a) => a.id),
    );
  }
  const account = book.accounts.find((a) => a.id === accountId);
  if (!account || (account.type !== "asset" && account.type !== "liability")) return new Set();
  return journalScope(book, accountId) ?? new Set();
}

/**
 * What one entry meant for the scope: the signed sum of its in-scope postings, in their
 * account's currency. `debit − credit` is the change in net position for an asset and a
 * liability alike — a debit grows an asset and shrinks a debt — so no branch on type is
 * needed, only on scope membership.
 *
 * `null` means "render the row as today": nothing in scope, money that never crossed the
 * scope's boundary (every posting inside — which also covers a cross-currency transfer
 * between own accounts, whose sum is not arithmetically zero), postings that cancel out,
 * or non-zero sums in more than one currency, which no valid entry produces.
 *
 * Opening balances and pending rows keep their sign but lose the colour: the first is a
 * starting point rather than earnings or spending, the second is not money yet.
 */
export function entryFlow(
  entry: Pick<JournalEntry, "kind" | "postings">,
  book: Book,
  scope: Set<string>,
  { pending = false }: { pending?: boolean } = {},
): EntryFlow | null {
  const inside = entry.postings.filter((p) => scope.has(p.accountId));
  if (inside.length === 0 || inside.length === entry.postings.length) return null;

  const byCurrency = new Map<string, number>();
  for (const posting of inside) {
    const currency =
      book.accounts.find((a) => a.id === posting.accountId)?.currency ?? book.homeCurrency;
    const delta = posting.side === "debit" ? posting.amount : -posting.amount;
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + delta);
  }
  // Empty when the in-scope postings cancel out; two or more only for an entry shape the
  // app never writes. Both fall back to today's display rather than a guess.
  const moved = [...byCurrency].filter(([, amount]) => amount !== 0);
  if (moved.length !== 1) return null;

  const [currency, amount] = moved[0];
  const muted = pending || entry.kind === "opening";
  return {
    tone: muted ? "none" : amount > 0 ? "pos" : "neg",
    text: formatSignedMinor(amount, currency),
  };
}
