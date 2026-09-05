import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createIndexedDbRepository } from "../adapters/indexeddb-repository";
import { errorMessage } from "../service/error-messages";
import { createLedgerApp } from "../service/ledger-app";
import type { Book } from "../kernel";
import { LedgerContext, type LedgerContextValue } from "./ledger-context";
import { syncSignal } from "./sync/sync-signal";

const CHANNEL_NAME = "khesh-sync";

export function LedgerProvider({ children }: { children: ReactNode }) {
  const repo = useMemo(() => createIndexedDbRepository(), []);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const app = useMemo(
    () =>
      createLedgerApp(repo, {
        afterCommit: (book) => {
          syncSignal.emit(book);
          channelRef.current?.postMessage("changed");
        },
      }),
    [repo],
  );
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

  // Another tab (or this tab's sync engine) changed IndexedDB: reload our state from it.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = channel;
    channel.onmessage = async () => {
      const result = await app.boot();
      if (result.ok) setBook(result.value);
    };
    return () => {
      channelRef.current = null;
      channel.close();
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
    repo,
    announceBookChanged: (next) => {
      setBook(next);
      channelRef.current?.postMessage("changed");
    },
  };

  return <LedgerContext.Provider value={value}>{children}</LedgerContext.Provider>;
}
