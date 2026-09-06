import type { Book } from "../../kernel";

type Listener = (book: Book) => void;

const listeners = new Set<Listener>();

/** Bridges the ledger app's afterCommit (created in LedgerProvider) to the sync
 * engine (created later, in SyncProvider) without a provider-ordering knot. */
export const syncSignal = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  emit(book: Book): void {
    for (const listener of [...listeners]) listener(book);
  },
};
