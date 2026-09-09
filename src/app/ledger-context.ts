import { createContext, useContext } from "react";
import type { Book } from "../kernel";
import type { LedgerErrorCode } from "../kernel/errors";
import type { LedgerRepository } from "../ports/ledger-repository";
import type { createLedgerApp } from "../service/ledger-app";
import type { LedgerStatus } from "./ledger-status";

export type LedgerAppInstance = ReturnType<typeof createLedgerApp>;

export type LedgerContextValue = {
  book: Book | null;
  loading: boolean;
  /** Which of the four top-level states the app is in. Derived — see `ledger-status.ts`. */
  status: LedgerStatus;
  /** Why the last boot failed, or null. Distinct from `error`, which is the transient
   * banner: an error the user can dismiss must never be what decides whether the app
   * offers to build a fresh book over a stored one. */
  bootError: LedgerErrorCode | null;
  error: string | null;
  clearError: () => void;
  setError: (message: string | null) => void;
  setBook: (book: Book | null) => void;
  /** Re-run `boot()`. The recovery screen's Retry is the only caller. */
  retryBoot: () => Promise<void>;
  /** Leave the recovery screen for onboarding by clearing `bootError`. Writes nothing:
   * the stored book is replaced only when the user finishes building its replacement. */
  startOver: () => void;
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
