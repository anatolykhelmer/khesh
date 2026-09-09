import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createIndexedDbRepository } from "../adapters/indexeddb-repository";
import { createLedgerApp } from "../service/ledger-app";
import type { Book } from "../kernel";
import type { LedgerErrorCode } from "../kernel/errors";
import { err, type Result } from "../kernel/result";
import { LedgerContext, type LedgerContextValue } from "./ledger-context";
import { deriveStatus } from "./ledger-status";
import { runExclusive } from "./sync/sync-lock";
import { syncSignal } from "./sync/sync-signal";

const CHANNEL_NAME = "khesh-sync";

export function LedgerProvider({ children }: { children: ReactNode }) {
  const repo = useMemo(() => createIndexedDbRepository(), []);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const app = useMemo(
    () =>
      createLedgerApp(repo, {
        // The sync engine (built in SyncProvider) is handed this same helper, so a
        // commit here and a cycle there take one lock and cannot overwrite each other.
        runExclusive,
        afterCommit: (book) => {
          syncSignal.emit(book);
          channelRef.current?.postMessage("changed");
        },
      }),
    [repo],
  );
  const [book, setBookState] = useState<Book | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bootError, setBootError] = useState<LedgerErrorCode | null>(null);

  // Any book assignment — including null — reconciles bootError with what storage
  // actually holds. A non-null book already outranks bootError in deriveStatus, so
  // clearing it there is belt-and-braces; the null route is the one that matters: it is
  // reached from the cross-tab BroadcastChannel handler (whose result.ok is true, so we
  // know storage read fine) and from announceBookChanged(null), which ledger-context.ts
  // documents as a reset that boots the other tabs into onboarding, same as a fresh
  // install — not into a stale recovery screen for a book that is no longer there.
  const setBook = useCallback((next: Book | null) => {
    setBookState(next);
    setBootError(null);
  }, []);

  /** The one place a boot result becomes state. Shared by the mount effect and
   * `retryBoot` so the two cannot drift. A failed boot sets `bootError` and NOT the
   * `error` banner: the recovery screen states the reason itself, and a dismissible
   * banner that also decided the routing is exactly the hazard BL-023 describes. */
  const applyBoot = useCallback((result: Result<Book | null>) => {
    if (!result.ok) {
      setBootError(result.error.code);
      // `setBookState`, NOT the `setBook` wrapper above: that wrapper clears `bootError`,
      // which would erase the code set one line up, derive "empty" instead of "failed",
      // and drop the user on onboarding with a live Continue over the book that just
      // failed to load — BL-023 exactly, with the whole suite still green. No test in a
      // node-environment repo can see the difference; this comment is the guard.
      setBookState(null);
    } else {
      setBootError(null);
      setBookState(result.value);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await app.boot();
      if (cancelled) return;
      applyBoot(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [app, applyBoot]);

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
    status: deriveStatus(loading, book, bootError),
    bootError,
    error,
    clearError: () => setError(null),
    setError,
    setBook,
    retryBoot: async () => {
      setLoading(true);
      // app.boot() should never reject — indexeddb-repository.ts wraps its whole body in
      // a catch — but that is not a contract this seam states or enforces, and this is
      // the only caller. A rejection must still resolve to a screen, not strand `loading`
      // at true forever with deriveStatus pinned to "loading" and no escape.
      try {
        applyBoot(await app.boot());
      } catch {
        applyBoot(err("STORAGE_UNAVAILABLE", "Failed to read storage"));
      }
    },
    startOver: () => setBootError(null),
    app,
    repo,
    announceBookChanged: (next: Book | null) => {
      setBook(next);
      channelRef.current?.postMessage("changed");
    },
  };

  return <LedgerContext.Provider value={value}>{children}</LedgerContext.Provider>;
}
