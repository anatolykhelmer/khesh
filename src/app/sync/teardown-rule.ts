import type { Book } from "../../kernel";

/**
 * Whether `SyncProvider` must tear this tab's Drive connection down.
 *
 * The state that is dangerous is a connection that was live *before* the book vanished.
 * Another tab's reset nulls the book here without touching this tab's engine or refs, so
 * they stay pointed at the old Drive file: the engine's next cycle can merge a freshly
 * onboarded book against the remote and silently restore the old one, and a first-connect
 * choice screen left standing has "Replace remote" wired to upload the new seed over the
 * real file. Both were found by BL-040's whole-branch review.
 *
 * That is a *transition*, and it has to be written as one now that a connection can also
 * *begin* while the book is null — the no-book screens (BL-043) offer Connect, and their
 * `pendingInspection` would otherwise be destroyed a moment after the user opened it.
 * Keying on "the book is null" was only ever an accurate approximation because that
 * could not happen.
 *
 * `previous` is `undefined` on the first render. Nothing needs tearing down there in any
 * case: `SyncProvider`'s resume effect only sets `connected` once the book is non-null,
 * and `pendingInspection` starts null.
 */
export function shouldTearDown(
  previous: Book | null | undefined,
  next: Book | null,
  hasSomethingToTearDown: boolean,
): boolean {
  if (!hasSomethingToTearDown) return false;
  if (previous === undefined || previous === null) return false;
  return next === null;
}
