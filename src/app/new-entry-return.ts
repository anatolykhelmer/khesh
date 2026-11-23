/**
 * Where a new entry's form returns to once it is saved.
 *
 * Started from the journal list, the form goes back to that exact view — month and
 * account included — and the journal says so if the new entry falls outside it.
 * Started anywhere else (the dashboard, the tab from another screen), it opens the
 * entry's own month across all accounts, where the entry is certain to be on screen.
 * Edits, deletions and posted occurrences are not this module's concern: they return
 * to the bare /journal, which restores the remembered view.
 */

/** Router state the New tab attaches when it is tapped on the journal list. */
export type NewEntryLinkState = { returnTo: string };

/** Router state the form attaches when it lands back on the journal. */
export type CreatedEntryState = { createdEntryId: string };

const JOURNAL_LIST = /^\/journal(\?.*)?$/;

/** State for the New tab's link: the journal list's address, or nothing from anywhere else. */
export function newEntryLinkState(location: {
  pathname: string;
  search: string;
}): NewEntryLinkState | undefined {
  if (location.pathname !== "/journal") return undefined;
  return { returnTo: `/journal${location.search}` };
}

function field(state: unknown, name: string): unknown {
  return typeof state === "object" && state !== null
    ? (state as Record<string, unknown>)[name]
    : undefined;
}

/**
 * The journal-list address the form was started from, or null. History state survives
 * reloads and is not ours to trust, so anything but a journal-list path is ignored.
 */
export function readReturnTo(state: unknown): string | null {
  const returnTo = field(state, "returnTo");
  return typeof returnTo === "string" && JOURNAL_LIST.test(returnTo) ? returnTo : null;
}

/** Where to go after creating an entry dated `date` (YYYY-MM-DD). */
export function afterCreatePath(returnTo: string | null, date: string): string {
  return returnTo ?? `/journal?month=${date.slice(0, 7)}`;
}

/** The id of the entry `after` has and `before` lacks, or null. */
export function addedEntryId(
  before: { journal: readonly { id: string }[] },
  after: { journal: readonly { id: string }[] },
): string | null {
  const known = new Set(before.journal.map((entry) => entry.id));
  return after.journal.find((entry) => !known.has(entry.id))?.id ?? null;
}

/** The id of the entry the form just created, read from the journal's router state. */
export function readCreatedEntryId(state: unknown): string | null {
  const id = field(state, "createdEntryId");
  return typeof id === "string" ? id : null;
}
