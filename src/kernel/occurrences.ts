/**
 * The id an entry posted from a recurrence carries. Deterministic on purpose: two devices
 * confirming the same occurrence offline produce the same id, so `mergeBooks` collapses
 * them into one entry under the rules it already has, and a duplicate payment cannot exist.
 *
 * This is the only place the format is written. Nothing reads a date back out of an id —
 * an entry's own `date` may differ from its occurrence date, and legitimately does when a
 * bill due on the 1st is paid on the 3rd.
 */
export function recurrenceEntryId(ruleId: string, date: string): string {
  return `rec:${ruleId}:${date}`;
}
