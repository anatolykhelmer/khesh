import type { Book } from "../kernel";
import type { LedgerErrorCode } from "../kernel/errors";

/** The four top-level states the app can be in. `App` renders one screen per value. */
export type LedgerStatus = "loading" | "empty" | "failed" | "ready";

/**
 * Which state is current. **Derived, never stored.**
 *
 * `setBook` has call sites across the app — `ImportBookButton`, and `use-ledger-mutation`
 * which carries every screen mutation including onboarding's own `createHousehold`. A
 * separately stored status would have to be updated at each of them, and the first thing
 * to break would be onboarding itself: Continue would save a book and leave the app
 * rendering the onboarding screen. Deriving it means every path that produces a book
 * already moves the app to `ready`, and no future call site can forget.
 *
 * A non-null book outranks a boot error: the error describes a book that has since been
 * replaced, by a Drive restore or a backup import.
 */
export function deriveStatus(
  loading: boolean,
  book: Book | null,
  bootError: LedgerErrorCode | null,
): LedgerStatus {
  if (loading) return "loading";
  if (book !== null) return "ready";
  if (bootError !== null) return "failed";
  return "empty";
}
