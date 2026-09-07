import { createContext, useContext } from "react";
import type { Book } from "../kernel";
import type { LedgerRepository } from "../ports/ledger-repository";
import type { createLedgerApp } from "../service/ledger-app";

export type LedgerAppInstance = ReturnType<typeof createLedgerApp>;

export type LedgerContextValue = {
  book: Book | null;
  loading: boolean;
  error: string | null;
  clearError: () => void;
  setError: (message: string | null) => void;
  setBook: (book: Book | null) => void;
  app: LedgerAppInstance;
  repo: LedgerRepository;
  /** Adopt a book written outside a mutation (sync merge, first connect) and tell
   * the other tabs to reload. `null` is a reset: the tabs that hear it boot into
   * onboarding, the same as a fresh install. */
  announceBookChanged: (book: Book | null) => void;
};

export const LedgerContext = createContext<LedgerContextValue | null>(null);

export function useLedger(): LedgerContextValue {
  const ctx = useContext(LedgerContext);
  if (!ctx) throw new Error("useLedger requires LedgerProvider");
  return ctx;
}
