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
