import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createIndexedDbRepository } from "../adapters/indexeddb-repository";
import { errorMessage } from "../service/error-messages";
import { createLedgerApp } from "../service/ledger-app";
import type { Book } from "../kernel";
import { LedgerContext, type LedgerContextValue } from "./ledger-context";

export function LedgerProvider({ children }: { children: ReactNode }) {
  const app = useMemo(() => createLedgerApp(createIndexedDbRepository()), []);
  const [book, setBook] = useState<Book | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await app.boot();
      if (cancelled) return;
      if (!result.ok) {
        setError(errorMessage(result.error.code));
        setBook(null);
      } else {
        setBook(result.value);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [app]);

  const value: LedgerContextValue = {
    book,
    loading,
    error,
    clearError: () => setError(null),
    setError,
    setBook,
    app,
  };

  return <LedgerContext.Provider value={value}>{children}</LedgerContext.Provider>;
}
