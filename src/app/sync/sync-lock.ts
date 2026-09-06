/**
 * The one Web Locks name the sync engine's cycle and every local commit both take.
 *
 * Two tabs share one IndexedDB, and only a lock they *both* name identically serializes
 * them: the cycle reloads and re-checks before it persists, but without this a commit in
 * the other tab can still land in the gap between that check and the cycle's own save,
 * and the cycle then overwrites it — and, since the same save is uploaded, propagates the
 * loss to every other device. Hence one constant rather than two string literals.
 *
 * The fallback runs `fn` unlocked: workers and older engines without `navigator.locks`
 * are single-tab environments (and the test suite has its own serialising stub), so
 * refusing to run would be worse than not serialising.
 */
export const SYNC_LOCK_NAME = "khesh-sync";

export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(SYNC_LOCK_NAME, fn) as Promise<T>;
  }
  return fn();
}
