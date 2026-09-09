import type { Book } from "../kernel";
import { errorMessage } from "../service/error-messages";
import type { Result } from "../kernel/result";

/** The pieces `performReset` needs from `useSync()` — not the whole context, so a test
 * can stub exactly this shape without touching React. */
export type ResetSyncDeps = {
  connected: boolean;
  /** Non-null means the first-connect choice UI is open: `storeRef`/`authRef`/`fileIdRef`
   * are already live even though `connected` is still false, so this alone must also
   * trigger teardown — otherwise the choice UI survives the reset armed at the old file. */
  pendingInspection: unknown;
  disconnect: () => Promise<void>;
};

export type ResetDeps = {
  sync: ResetSyncDeps;
  resetAll: () => Promise<Result<void>>;
  announceBookChanged: (book: Book | null) => void;
  setError: (message: string | null) => void;
};

/**
 * The reset sequence Settings' danger zone drives: disconnect Drive sync (when there is
 * anything to disconnect — a live connection or a still-pending first-connect choice),
 * erase the local book, and only then announce the null book. Announcing before the erase
 * lands would race the onboarding screen against a book that still exists; disconnecting
 * after it would leave a window where a live engine can see the newly-empty storage.
 *
 * Extracted out of the DangerZone component so this ordering has a test: this repo's
 * Vitest runs in `environment: "node"` with no component-testing library, so a React
 * component itself cannot be exercised here.
 */
export async function performReset(deps: ResetDeps): Promise<void> {
  try {
    if (deps.sync.connected || deps.sync.pendingInspection !== null) {
      await deps.sync.disconnect();
    }
  } catch {
    // sync.disconnect() cannot reject today (see SyncProvider), but this button is the
    // app's most destructive: an unhandled rejection here must still reach the user as a
    // banner rather than vanish silently.
    deps.setError(errorMessage("SYNC_STORE_FAILED"));
    return;
  }

  const result = await deps.resetAll();
  if (!result.ok) {
    deps.setError(errorMessage(result.error.code));
    return;
  }

  deps.setError(null);
  // No book: App renders OnboardingScreen here, and the other tabs follow the
  // broadcast into the same place.
  deps.announceBookChanged(null);
}

export type StartOverDeps = {
  /** Only `disconnect` — deliberately not `connected` or `pendingInspection`. See below:
   * on the recovery screen those are both always idle, and a flow that consulted them
   * would do nothing at all. */
  sync: { disconnect: () => Promise<void> };
  /** `LedgerProvider.startOver`: clears `bootError`, writes nothing. */
  startOver: () => void;
  setError: (message: string | null) => void;
};

/**
 * Leaving the recovery screen for onboarding: disconnect Drive sync, then clear the boot
 * error. Same ordering discipline as `performReset` and the same reason to be a plain
 * function — this repo's Vitest runs in `environment: "node"` with no component-testing
 * library, so a sequence living in a component has no tests.
 *
 * **Why disconnect at all.** Sync meta lives in its own IndexedDB database
 * (`sync-meta-store.ts`), so it survives whatever corrupted the ledger and put the user
 * here. `startOver()` alone left it live: Continue then mints a seed, `book` goes
 * non-null, `SyncProvider`'s resume effect fires because the stored `connected` is still
 * true, and the engine's first cycle takes the union branch — the user's real book comes
 * back plus four duplicated root accounts, root ids being per-device. No choice screen,
 * no warning, and the spec's "merge is never offered when the local side holds no data"
 * bypassed on the very path this screen was added for. The start-over warning even says
 * "connect Google Drive first", promising Drive is inert until you do.
 *
 * **Why unconditionally**, where `performReset` asks whether there is anything to
 * disconnect. That question is about `useSync()`'s in-memory state, and on the recovery
 * screen it is always no: the resume effect is gated on `book !== null`, so `connected`
 * never becomes true while a book has failed to load, and a first-connect that reached
 * `pendingInspection` and was applied would have produced a book and left this screen.
 * Copying the gate would read as caution and disconnect nothing. `teardownConnection` is
 * idempotent and null-safe on every ref it touches, so running it against an idle tab
 * costs one best-effort write to the meta database.
 *
 * **It erases nothing.** No repository, no `resetAll` — the type above carries no way to
 * reach storage, and that is the point. The stored book stays until onboarding's Continue
 * overwrites it, so closing the tab in between brings the recovery screen back with the
 * book still there. That property is what makes "start over" safe to offer at all.
 */
export async function performStartOver(deps: StartOverDeps): Promise<void> {
  try {
    await deps.sync.disconnect();
  } catch {
    // Same reasoning as `performReset`: disconnect cannot reject today, but leaving the
    // recovery screen with a Drive connection still live is the whole failure this flow
    // exists to prevent. Surface it and stay put rather than proceed on a guess.
    deps.setError(errorMessage("SYNC_STORE_FAILED"));
    return;
  }

  deps.setError(null);
  deps.startOver();
}
