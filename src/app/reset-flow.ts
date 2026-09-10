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
  /** Clears whatever the first-connect flow has on screen — `SyncProvider`'s
   * `setStage(IDLE)`, and nothing else. Needed beyond `disconnect` because a *dropped*
   * plan holds neither a connection nor an inspection: both fields above read quiet, the
   * gate below skips the teardown that would have cleared it, and the notice explaining a
   * book move that happened before the erase rides through onto the fresh onboarding
   * screen.
   *
   * **It is not cancellation**, and comments elsewhere used to lean on it as though it
   * were. It cannot see a `connect()` that is in flight, let alone stop one: an inspection
   * already under way still returns, still holds the store and auth it bound to the user's
   * real Drive file, and still finalizes. What stops that is `connectStillApplies` in the
   * provider and the erase flag `DangerZone` now publishes to `SyncSection`. */
  cancelConnect: () => void;
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
 * **This sequence leaves a window it cannot close itself.** `disconnect()` ends with
 * `connected: false`, so from the moment it resolves until `announceBookChanged(null)`
 * unmounts the screen, Settings renders its disconnected view — an enabled Connect row —
 * for the whole of `resetAll()`. A connect finalizing in there arms an engine at the user's
 * real Drive file while the local book is being erased, and the teardown effect cannot
 * recover: it consumes the book's null transition on a render where `connected` is still
 * false, and `shouldTearDown` needs a non-null `previous` to fire again. Nothing available
 * here fixes that — `cancelConnect()` clears the screen, not an in-flight `connect()`, and
 * `useSync()` cannot tell the provider that the erase is still running. It is closed by the
 * caller instead: `DangerZone` holds `busy` for the whole of this function and publishes it
 * to `SyncSection`, which disables Connect and Reconnect. That indirection is the guard —
 * it is not decoration, and removing it reopens BL-040.
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
  // After the erase and before the announce: whatever the first-connect flow had to say
  // was about the book that no longer exists, and the screen this is one line from
  // opening is onboarding's. Not earlier — an erase that fails leaves the book, and with
  // it every reason the notice was put up.
  //
  // Clearing the screen only. This line has been cited more than once as though it made
  // the erase safe against a connect started underneath it; it does not, and cannot —
  // see `ResetSyncDeps.cancelConnect`.
  deps.sync.cancelConnect();
  // No book: App renders OnboardingScreen here, and the other tabs follow the
  // broadcast into the same place.
  deps.announceBookChanged(null);
}

export type StartOverDeps = {
  /** Only `disconnect` — deliberately not `connected` or `pendingInspection`. See below:
   * the connection this flow has to end is the one in the sync-meta database, which
   * neither field reports. Carrying them would only invite the gate that skips it. */
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
 * disconnect. That question reads `useSync()`, and here `useSync()` cannot see the thing
 * that does the damage. `connected` is false: the resume effect is gated on
 * `book !== null`, so it never runs while a book has failed to load — which is exactly
 * why the *stored* `meta.connected` can still be true, sitting in its own database,
 * untouched by whatever corrupted the ledger. That stored record is what Continue would
 * resume from. A `performReset`-style gate would find both fields quiet in precisely the
 * common case and skip the one write that makes Continue safe.
 *
 * Note what is *not* the reason: `pendingInspection` is not always idle here. This screen
 * renders `ConnectDrive` (BL-043), so an unapplied choice is a live connection —
 * `storeRef`, `authRef` and `fileIdRef` are bound to the user's Drive file from the
 * moment `connect()` inspects it. It is a second thing worth tearing down, not an
 * argument that there is nothing to tear down.
 *
 * The same gate is correct where `performReset` uses it: Settings is reachable only with
 * a book, so the resume effect has run and `connected` does reflect the stored record.
 *
 * `teardownConnection` is idempotent and null-safe on every ref it touches, so running it
 * against a genuinely idle tab costs one best-effort write to the meta database. It is
 * also why this flow needs no `cancelConnect` of its own where `performReset` does: the
 * unconditional call ends the first-connect flow on every path, dropped plan included
 * (`afterTeardown`, cause `userAction`).
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
