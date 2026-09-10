import type { FirstConnectPlan, LocalState, RemoteInspection } from "../../service/sync-connect";

/**
 * Where the first-connect flow stands.
 *
 * One value rather than a plan plus a "was it dropped" flag, because the two are one
 * fact. A render showing live choices *and* a line saying the choices were lost — or the
 * inspection without its plan, or the plan without the `plannedFor` that says whether it
 * still applies — would be exactly the inconsistency this type exists to make
 * unrepresentable.
 *
 * `dropped` is not merely "idle with a message". It is terminal until something clears
 * it: a plan dropped because the book moved must not come back if the book moves back.
 */
export type ConnectStage =
  | { kind: "idle" }
  | {
      kind: "choosing";
      inspection: RemoteInspection;
      plan: FirstConnectPlan;
      /** What `localState` was when `firstConnectOptions` produced `plan`. */
      plannedFor: LocalState;
    }
  | { kind: "dropped" };

/** Shared instances, so a caller can ask "did this transition change anything?" with
 * `!==` rather than by comparing fields. Nothing ever mutates a stage. */
export const IDLE: ConnectStage = { kind: "idle" };
export const DROPPED: ConnectStage = { kind: "dropped" };

/**
 * The stage after the local book has moved — or after it has not.
 *
 * `connect()` reads `localState` *before* it awaits `inspectRemote`, so a `choosing`
 * stage describes the local side as it stood a network round-trip ago. Nothing else
 * re-derives it. Three ways the book moves underneath, each with its own damage:
 *
 * - **Another tab resets** while the inspection is in flight. `buildStore()` has already
 *   bound `fileIdRef` to the user's real Drive file, but the stage is still `idle` at the
 *   moment of the transition, so `shouldTearDown` correctly sees nothing to tear down.
 *   The screen then renders from the captured `local: "real"` and offers all three
 *   choices — "Upload this device's book" uploads a freshly-seeded book over the real
 *   one. That is BL-040's hole, reopened from the other side.
 * - **Onboarding.** The Drive is empty, so the plan is `explain remoteEmpty`; the user
 *   taps Continue rather than Cancel. Settings then states "there is no Khesh book in
 *   your Google Drive yet" over a Cancel button — now false, and a dead end.
 * - **Recovery.** The plan offers `useRemote`; the user restores a backup on the same
 *   screen instead. Settings then offers to replace the backup they just restored.
 *
 * Drop rather than re-derive. The user tapped Connect while looking at one local state;
 * silently re-planning for another is precisely the "choices shifting under the user's
 * finger" that deciding the plan once was meant to prevent. A dropped plan costs one more
 * tap on Connect, which re-inspects — and, since BL-050, says so on screen.
 *
 * `applying` is the one exception. While a choice is being applied the local state is
 * moving *because of that choice*: `applyChoice("useRemote")` replaces the book, so the
 * plan goes stale by succeeding, and `finalizeConnect` only clears the stage after a
 * network round trip for the account email. Dropping there would announce "the book
 * changed, connect again" over a choice that is completing. Nothing is lost by waiting:
 * on success the stage is cleared, and on failure the next render drops it correctly.
 */
export function afterLocalStateChange(
  stage: ConnectStage,
  localState: LocalState,
  applying: boolean,
): ConnectStage {
  if (stage.kind !== "choosing") return stage;
  if (applying) return stage;
  return stage.plannedFor === localState ? stage : DROPPED;
}

/**
 * The stage a connection teardown leaves behind.
 *
 * A live choice screen goes: `teardownConnection` has just dropped the store, the auth
 * and the file id the choices would act on. A drop notice stays, and that is the whole
 * reason this function exists rather than a bare `setStage(IDLE)`. When another tab
 * erases the book, the teardown effect and the drop fire on the same flush; the teardown
 * then runs three awaits and finishes *after* the notice is on screen, so an
 * unconditional clear would silently eat the message a few microtasks after it appeared.
 *
 * A user's own Disconnect while the notice shows therefore leaves it showing. The
 * sentence is still true, and telling the two callers apart would buy nothing.
 */
export function afterTeardown(stage: ConnectStage): ConnectStage {
  return stage.kind === "dropped" ? stage : IDLE;
}
