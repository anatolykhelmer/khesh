import type { FirstConnectPlan, LocalState, RemoteInspection } from "../../service/sync-connect";

/**
 * A first-connect choice screen waiting for the user, stamped with the local state its
 * plan was derived from.
 *
 * The three fields are one value because they are one decision: `SyncProvider` writes and
 * clears them together, and a render that showed the inspection without its plan — or the
 * plan without the `plannedFor` that says whether it still applies — would be exactly the
 * inconsistency this type exists to make unrepresentable.
 */
export type PendingConnect = {
  inspection: RemoteInspection;
  plan: FirstConnectPlan;
  /** What `localState` was when `firstConnectOptions` produced `plan`. */
  plannedFor: LocalState;
};

/**
 * Whether a pending first-connect plan has outlived the local state it was derived from.
 *
 * `connect()` reads `localState` *before* it awaits `inspectRemote`, so the plan describes
 * the local side as it stood a network round-trip ago. Nothing else re-derives it. Three
 * ways the book moves underneath, each with its own damage:
 *
 * - **Another tab resets** while the inspection is in flight. `buildStore()` has already
 *   bound `fileIdRef` to the user's real Drive file, but `pendingInspection` is still null
 *   at the moment of the transition, so `shouldTearDown` correctly sees nothing to tear
 *   down. The screen then renders from the captured `local: "real"` and offers all three
 *   choices — "Upload this device's book" uploads a freshly-seeded book over the real one.
 *   That is BL-040's hole, reopened from the other side.
 * - **Onboarding.** The Drive is empty, so the plan is `explain remoteEmpty`; the user taps
 *   Continue rather than Cancel. Settings then states "there is no Khesh book in your
 *   Google Drive yet" over a Cancel button — now false, and a dead end.
 * - **Recovery.** The plan offers `useRemote`; the user restores a backup on the same
 *   screen instead. Settings then offers to replace the backup they just restored.
 *
 * Drop rather than re-derive. The user tapped Connect while looking at one local state;
 * silently re-planning for another is precisely the "choices shifting under the user's
 * finger" that deciding the plan once was meant to prevent. A dropped plan costs one more
 * tap on Connect, which re-inspects.
 */
export function isPendingPlanStale(
  pending: { plannedFor: LocalState } | null,
  localState: LocalState,
): boolean {
  if (pending === null) return false;
  return pending.plannedFor !== localState;
}
