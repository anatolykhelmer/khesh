import { currentYearMonth, formatYearMonth } from "../service/dates";
import { hasExplicitJournalView, type JournalFilterState } from "./journal-filter";

/**
 * How the journal was last being viewed, so a bare /journal can return to it.
 * The account and all-time mode live on the device (localStorage), so a fresh launch
 * keeps them. A specific month lives only as long as the tab (sessionStorage): browsing
 * September today should not mean opening September next week. Not synced through the
 * book — how one person browses is not a fact about the family's money.
 */
export const JOURNAL_VIEW_KEY = "khesh:journal-view";
export const JOURNAL_MONTH_KEY = "khesh:journal-month";

export type JournalViewStores = { local: Storage | null; session: Storage | null };

type RememberedView = { accountId: string | null; allTime: boolean };

const NOTHING: RememberedView = { accountId: null, allTime: false };

// Storage may refuse every call (some private-browsing modes); that only means
// the view is not remembered this time.
function safeGet(store: Storage | null, key: string): string | null {
  if (!store) return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(store: Storage | null, key: string, value: string): void {
  if (!store) return;
  try {
    store.setItem(key, value);
  } catch {
    // not remembered
  }
}

function safeRemove(store: Storage | null, key: string): void {
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    // nothing to forget
  }
}

function readRemembered(local: Storage | null): RememberedView {
  const raw = safeGet(local, JOURNAL_VIEW_KEY);
  if (raw === null) return NOTHING;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NOTHING;
  }
  if (typeof parsed !== "object" || parsed === null) return NOTHING;
  const fields = parsed as Record<string, unknown>;
  return {
    accountId: typeof fields.accountId === "string" ? fields.accountId : null,
    allTime: fields.allTime === true,
  };
}

/** Query parameters for the remembered view; empty when nothing usable is remembered. */
export function readJournalView(stores: JournalViewStores): URLSearchParams {
  const params = new URLSearchParams();
  const { accountId, allTime } = readRemembered(stores.local);
  if (allTime) {
    params.set("month", "all");
  } else {
    // Validated one layer later by parseYearMonthParam, which falls back to the current month.
    const month = safeGet(stores.session, JOURNAL_MONTH_KEY);
    if (month !== null) params.set("month", month);
  }
  if (accountId !== null) params.set("account", accountId);
  return params;
}

/** Remember the view now on screen. The current month is the default, so it is not stored. */
export function writeJournalView(
  state: JournalFilterState,
  stores: JournalViewStores,
  now = new Date(),
): void {
  const remembered: RememberedView = { accountId: state.accountId, allTime: state.period === null };
  safeSet(stores.local, JOURNAL_VIEW_KEY, JSON.stringify(remembered));
  const current = currentYearMonth(now);
  const isCurrentMonth =
    state.period !== null &&
    state.period.year === current.year &&
    state.period.month === current.month;
  if (state.period === null || isCurrentMonth) safeRemove(stores.session, JOURNAL_MONTH_KEY);
  else safeSet(stores.session, JOURNAL_MONTH_KEY, formatYearMonth(state.period));
}

/** Forget the view (the Reset button). */
export function clearJournalView(stores: JournalViewStores): void {
  safeRemove(stores.local, JOURNAL_VIEW_KEY);
  safeRemove(stores.session, JOURNAL_MONTH_KEY);
}

/**
 * Call before writing a query string. A bare one means "return to the remembered view",
 * so a write that leaves it bare — Reset, or "All accounts" on ?account=X — must forget
 * first, or memory would put the old view straight back.
 */
export function forgetIfBare(next: URLSearchParams, stores: JournalViewStores): void {
  if (!hasExplicitJournalView(next)) clearJournalView(stores);
}

function storeOrNull(get: () => Storage | undefined): Storage | null {
  try {
    return get() ?? null;
  } catch {
    // Reading window.localStorage itself can throw a SecurityError.
    return null;
  }
}

/** The browser's stores, or null where they are absent or refuse to be touched. */
export function browserStores(): JournalViewStores {
  return {
    local: storeOrNull(() => (typeof localStorage === "undefined" ? undefined : localStorage)),
    session: storeOrNull(() => (typeof sessionStorage === "undefined" ? undefined : sessionStorage)),
  };
}
