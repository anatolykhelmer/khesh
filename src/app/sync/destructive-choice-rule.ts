import type { FirstConnectChoice, LocalState, RemoteInspection } from "../../service/sync-connect";

/**
 * Whether a first-connect choice destroys data, and so must be confirmed before it runs.
 *
 * `firstConnectOptions` decides what is *sensible* to offer; this decides what is *safe*
 * to run on one tap. The two are separate questions and the review found both halves of
 * the gap: `replaceRemote` stays offered when local is a seed and Drive holds a real book,
 * so one tap uploads a provably empty book over N journal entries; `useRemote` with a real
 * local book deletes it just as silently from the other side.
 *
 * The rule reads the same two axes the plan was decided from, so it cannot disagree with
 * the screen: a choice deletes the remote when the remote is a readable book, and deletes
 * the local when `plannedFor` is `"real"`. Everything else — an empty or unreadable
 * remote, a seed or absent local, and `merge`, which unions rather than replaces — has
 * nothing to lose and gets no extra tap.
 *
 * Deliberately not "is the outcome surprising": `merge` on a real book is surprising
 * enough to carry its own warning line, but it deletes nothing, and a confirm on every
 * button is a confirm on none.
 */
export function needsConfirmation(
  choice: FirstConnectChoice,
  remote: RemoteInspection,
  plannedFor: LocalState,
): boolean {
  if (choice === "replaceRemote") return remote.kind === "book";
  if (choice === "useRemote") return plannedFor === "real";
  return false;
}
