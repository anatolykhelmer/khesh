import type { Book } from "../kernel";
import { errorMessage } from "../service/error-messages";
import type { Result } from "../kernel/result";

/** The pieces `performReset` needs from `useSync()` — not the whole context, so a test
 * can stub exactly this shape without touching React. */
export type ResetSyncDeps = {
  /** Run unconditionally, and **deliberately without a `connected` or `pendingInspection`
   * field to gate it on** — the same shape, for the same reason, as `StartOverDeps`.
   * Carrying those fields is what invited the gate that skipped this call; see
   * `performReset`'s own "why unconditionally". */
  disconnect: () => Promise<void>;
  /** Clears whatever the first-connect flow has on screen — the session's
   * `cancelConnect`, which writes `IDLE` and nothing else.
   *
   * **No longer the thing that closes the dropped-plan hole.** It was, while the
   * `disconnect()` above was gated: a dropped plan holds neither a connection nor an
   * inspection, so the gate read quiet, skipped the teardown, and the notice explaining a
   * book move from before the erase rode onto the fresh onboarding screen. With the gate
   * gone, `afterTeardown(stage, { cause: "userAction" })` answers `IDLE` from every stage,
   * so the teardown already clears it — exactly as `performStartOver` relies on, which is
   * why that flow carries no `cancelConnect` at all. What is left here is one `setState`
   * that needs no connection, no port and no await: the teardown's own stage write sits
   * past two round trips whose failures it swallows, and this does not.
   *
   * **It is not cancellation**, and comments elsewhere used to lean on it as though it
   * were. It cannot see a `connect()` that is in flight, let alone stop one: an inspection
   * already under way still returns, still holds the store and auth it bound to the user's
   * real Drive file, and still finalizes. What stops that is the connect itself finding an
   * erase began under it and turning away, and the `erasing` flag the session itself
   * consults before it starts a connect or adopts a stored connection, which keeps a
   * second one from starting. */
  cancelConnect: () => void;
  /** Published to every screen through the sync snapshot for the whole of `performReset`.
   * Replaces the `DangerZone → SettingsScreen → SyncSection → ConnectDrive` prop chain,
   * whose middle hops were invisible to the suite: deleting both left 724/724 green. */
  beginErase: () => void;
  endErase: () => void;
};

export type ResetDeps = {
  sync: ResetSyncDeps;
  resetAll: () => Promise<Result<void>>;
  announceBookChanged: (book: Book | null) => void;
  setError: (message: string | null) => void;
};

/**
 * The reset sequence Settings' danger zone drives: disconnect Drive sync, erase the local
 * book, and only then announce the null book. Announcing before the erase lands would race
 * the onboarding screen against a book that still exists; disconnecting after it would
 * leave a window where a live engine can see the newly-empty storage.
 *
 * **Why the disconnect is unconditional.** It used to ask first —
 * `if (connected || pendingInspection !== null)` — and both fields are a React snapshot,
 * which is a *photograph of something that can still become true*. The window is a tab at
 * boot: `setBook(book)` has started `resumeStoredConnection`, its `metaStore.load()` is
 * still in flight, and until it lands `connected` is false and there is no inspection. Erase
 * in there and the gate read quiet, so nothing wrote `connected: false`; `resetAll()` clears
 * the ledger database and does not touch `sync-meta`. The resume then refuses — for
 * `erasing`, or for the null book — and a refusal is deliberately not an answer, so the
 * question is asked again the moment the wizard's fresh seed arrives. That retry loads a
 * record still saying `connected: true` at the old `fileId`, adopts it, arms an engine, and
 * its first cycle pulls the Drive book back over the seed. **The user erased their book and
 * it came back** — BL-040's own class, reached through the retry.
 *
 * So this asks nothing. `disconnect()` is idempotent and null-safe: `teardown` captures
 * `current` as null, skips the release, and still writes
 * `{ connected: false, accountEmail: null, lastSyncAt: null }` and settles the snapshot. The
 * cost on a genuinely idle tab is one meta write, on a path that is one line from erasing
 * everything; what it buys is that the post-erase retry loads a *decided negative* and
 * settles quietly instead of adopting. `performStartOver` already reasoned its way to the
 * same unconditional call for the same class of hole, and the fields are gone from
 * `ResetSyncDeps` so the gate cannot come back without a type change.
 *
 * The residual this does not close: `teardown` swallows a rejecting `metaStore.save`, so an
 * erase whose meta write fails leaves the stored record still saying connected and the
 * retry still adopts. That is a defect in the teardown's own failure reporting, one layer
 * down, and not something a second guard here could honestly fix — it survives a reload,
 * which nothing in this function does.
 *
 * **This sequence leaves a window it cannot close on `cancelConnect()` alone.**
 * `disconnect()` ends with `connected: false`, so from the moment it resolves until
 * `announceBookChanged(null)` unmounts the screen, Settings renders its disconnected view —
 * an enabled Connect row — for the whole of `resetAll()`. A connect finalizing in there arms
 * an engine at the user's real Drive file while the local book is being erased, and the
 * teardown effect cannot recover: it consumes the book's null transition on a render where
 * `connected` is still false, and `shouldTearDown` needs a non-null `previous` to fire
 * again. `beginErase()`/`endErase()` bracket the whole of this function for exactly that
 * reason: `erasing` reaches every screen through the sync snapshot itself, not through a
 * prop threaded down from this function's one caller, and the `finally` is what keeps a
 * failed `resetAll` from leaving it stuck on. That bracket is the guard, not decoration.
 * `ConnectDrive` and `SyncSection` read it back as `activity.blocking` (`erasing` is one of
 * the flags folded into it), and — the half that does not depend on a screen remembering —
 * the session refuses to start a connect or adopt a stored connection while it is set.
 * `DangerZone` is deliberately *not* in that list: `blocking` folds in the `erasing` this
 * function is about to set, so gating the erase button on it would gate the erase on its
 * own erase. Removing either call reopens BL-040 exactly as before, just with no prop left
 * for a reviewer to notice is missing.
 *
 * Extracted out of the DangerZone component so this ordering has a test: this repo's
 * Vitest runs in `environment: "node"` with no component-testing library, so a React
 * component itself cannot be exercised here.
 */
export async function performReset(deps: ResetDeps): Promise<void> {
  deps.sync.beginErase();
  try {
    try {
      await deps.sync.disconnect();
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
    // opening is onboarding's.
    //
    // Redundant as of the unconditional `disconnect()` above, and kept as the one clear
    // that runs through no port — see `ResetSyncDeps.cancelConnect`. Say plainly what that
    // costs, since the placement below the erase used to be load-bearing: the teardown
    // clears the notice on the *failed*-erase path too now, where this line alone would
    // have left it up with the book it describes still there. That was already true
    // whenever anything was connected; it is now true always.
    //
    // Clearing the screen only. This line has been cited more than once as though it made
    // the erase safe against a connect started underneath it; it does not, and cannot —
    // see `ResetSyncDeps.cancelConnect`.
    deps.sync.cancelConnect();
    // No book: App renders OnboardingScreen here, and the other tabs follow the
    // broadcast into the same place.
    deps.announceBookChanged(null);
  } finally {
    // In a `finally`, so a failed `resetAll` cannot leave every screen's Connect disabled
    // for the rest of the session.
    deps.sync.endErase();
  }
}

export type StartOverDeps = {
  /** Only `disconnect` — deliberately not `connected` or `pendingInspection`. See below:
   * the connection this flow has to end is the one in the sync-meta database, which
   * neither field reports. Carrying them would only invite the gate that skips it, which
   * is precisely what happened in `performReset` until it was removed there too. */
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
 * **Why unconditionally.** An "is there anything to disconnect?" question reads
 * `useSync()`, and here `useSync()` cannot see the thing that does the damage. `connected`
 * is false: the resume effect is gated on `book !== null`, so it never runs while a book
 * has failed to load — which is exactly why the *stored* `meta.connected` can still be
 * true, sitting in its own database, untouched by whatever corrupted the ledger. That
 * stored record is what Continue would resume from. Such a gate would find both fields
 * quiet in precisely the common case and skip the one write that makes Continue safe.
 *
 * Note what is *not* the reason: `pendingInspection` is not always idle here. This screen
 * renders `ConnectDrive` (BL-043), so an unapplied choice is a live connection — the
 * session's `Connection` is bound to the user's Drive file from the moment `connect()`
 * inspects it. It is a second thing worth tearing down, not an argument that there is
 * nothing to tear down.
 *
 * This doc used to add that the gate was nonetheless correct in `performReset`, because
 * Settings is reachable only with a book so the resume has run and `connected` reflects the
 * stored record. That was false, and it was the hole: the resume is asynchronous, and a
 * Settings screen reached before its `metaStore.load()` lands reads `connected: false` over
 * a record that says otherwise. `performReset` now disconnects unconditionally too, and its
 * own doc carries the walk-through.
 *
 * The session's teardown is idempotent and does nothing at all when there is no
 * connection, so running it against a genuinely idle tab costs one best-effort write to
 * the meta database. It is
 * also why this flow needs no `cancelConnect` of its own: the unconditional call ends the
 * first-connect flow on every path, dropped plan included (`afterTeardown`, cause
 * `userAction`).
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
