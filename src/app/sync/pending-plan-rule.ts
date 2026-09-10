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
 *
 * The one case where waiting *would* lose something — the book vanishing under an apply,
 * where this suppression means no drop is ever committed — is not this function's to
 * catch: the same flush tears the connection down, and `afterTeardown` settles the stage
 * itself on that path.
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
 * Why the connection is being torn down — and, when a vanished book is why, *which* plan
 * the teardown set out to end.
 *
 * The two callers of `teardownConnection` want opposite things from a first-connect plan
 * that is still on screen, so the caller says which it is rather than the rule guessing
 * from the stage. `bookVanished` carries one thing more, because the cause alone is not
 * enough to identify the plan: see `afterTeardown`.
 *
 * The two arms are a union rather than one optional field so the type refuses both
 * mistakes — a vanished-book teardown that forgot to name the plan it started from, and a
 * user action pretending to have one.
 */
export type TeardownIntent =
  /** Disconnect, the Settings reset, start over. The user ended the flow themselves. */
  | { cause: "userAction" }
  /** `SyncProvider`'s effect: the local book disappeared from under a live connection or
   * a live choice screen — another tab reset it. `startedFrom` is the stage as it stood
   * when the teardown began, which is not necessarily the stage that will be current
   * when it finishes. */
  | { cause: "bookVanished"; startedFrom: ConnectStage };

/**
 * The stage a connection teardown leaves behind, which depends on *why* it happened.
 *
 * A live choice screen cannot survive either way: `teardownConnection` has just dropped
 * the store, the auth and the file id its choices would act on. What differs is whether
 * the user is owed a sentence about it.
 *
 * - **`bookVanished`** is exactly the transition BL-050 exists to explain, so this
 *   teardown *is* the drop — the plan it started from ends in `dropped` here rather than
 *   waiting for `afterLocalStateChange` to reach the same answer. It used to wait: the
 *   drop and this teardown fire on the same flush, the teardown then runs three awaits,
 *   so the notice was assumed to be on screen by the time this ran. That assumption fails
 *   whenever a choice was being applied when the book went — `afterLocalStateChange`
 *   suppresses the drop while `applying`, so nothing was ever committed, this found
 *   `choosing` and wrote `IDLE`, and all the user got was the raw "sync is not connected"
 *   the doomed apply then failed with.
 * - **`userAction`** clears, notice included. Disconnect, reset and start over all end
 *   the first-connect flow deliberately; a notice that outlived the erase which made it
 *   irrelevant would surface on the fresh onboarding screen explaining an event from
 *   before it. (Disconnect itself cannot be tapped while the notice shows — the button
 *   only exists in the connected view, and becoming connected clears the stage — so this
 *   arm is about the two erase flows.)
 *
 * **Why `bookVanished` needs `startedFrom`, and this is the ordering assumption that
 * really is gone.** The three awaits are still there, and nothing bounds them:
 * `revoke()` is a network round trip with no timeout of its own, so this last line can
 * land arbitrarily late. `connect()` is not blocked in the meantime — it recreates the
 * auth and the store the teardown nulled — so by the time this runs the user may be
 * looking at a *second*, perfectly valid plan, decided from the local state the vanished
 * book left behind. Answering `dropped` for "whatever `choosing` is current" would print
 * the BL-050 notice over that plan: a false sentence, on the branch that exists to make
 * this sentence true. Identity is the whole test — stages are frozen and every
 * `choosing` is a fresh object from one `connect()`, so `stage === intent.startedFrom`
 * means "still the plan this teardown was about" and nothing else.
 *
 * The `kind` check beside it is not redundant with that identity. A teardown that begins
 * at `idle` — the plain connected tab of BL-040, no plan ever offered — would otherwise
 * match itself and put the notice on a screen that never showed choices.
 *
 * `dropped` stays terminal everywhere else: it survives the teardown that caused it. Only
 * the next `connect()`, adopting a connection another tab made, or a deliberate end to
 * the flow clears it.
 *
 * `userAction` needs no such care. Its two flows disable the Connect button for the
 * length of the teardown (`RecoveryScreen`'s `startingOver`) or end by calling
 * `cancelConnect()` themselves after the erase (`performReset`), so no plan started
 * mid-teardown survives to be wrongly cleared — and clearing is this arm's answer for
 * every stage anyway.
 */
export function afterTeardown(stage: ConnectStage, intent: TeardownIntent): ConnectStage {
  if (intent.cause === "userAction") return IDLE;
  if (stage.kind === "choosing" && stage === intent.startedFrom) return DROPPED;
  return stage;
}

/**
 * Whether a teardown's tail still speaks for this tab's connection — that is, whether it
 * may still write "disconnected" into this tab's state and the shared meta record.
 *
 * `teardownConnection` clears the refs synchronously and then runs a tail behind three
 * awaits, none of them bounded (`revoke()` is a network round trip with no timeout of its
 * own). A `connect()` can complete inside that window — after a vanished book the drop
 * notice asks the user for exactly that — and `finalizeConnect` will have written the
 * opposite of everything the tail is about to write. `connectionsAtStart` is the count of
 * connections this tab had established when the teardown began; `connectionsNow` is the
 * count when the tail landed.
 *
 * **The two causes want opposite answers, and that asymmetry is the whole of this
 * function.** A vanished book is the app's own judgement, and a connect the user made
 * afterwards is newer information about a local state the erase left behind, so it wins.
 * A `userAction` teardown is not a judgement to be overruled: the user asked to
 * disconnect, reset or start over, and those flows *continue* — `performReset` erases the
 * book next, `performStartOver` opens onboarding. Letting a connect win there leaves
 * `connected: true` persisted with a live engine pointed at the real Drive file while the
 * book is null and onboarding is on screen, whose Continue then merges a fresh seed
 * against the real remote. That is BL-040, the failure these flows exist to prevent.
 *
 * The teardown effect cannot be relied on to clean that up afterwards: it writes
 * `previousBookRef.current = book` on every run, so a run that sees the book go null while
 * `connected` is still false consumes the transition, and `shouldTearDown` — which needs
 * `previous` to be non-null — can never fire for it again.
 */
export function teardownStillApplies(
  intent: TeardownIntent,
  connectionsAtStart: number,
  connectionsNow: number,
): boolean {
  if (intent.cause === "userAction") return true;
  return connectionsAtStart === connectionsNow;
}

/**
 * Which error the Connect row may still show in red, once the stage has had its say.
 *
 * `lastError` is not part of `ConnectStage`. It is `errorMessage(code)` from a real
 * failure, written and cleared on its own schedule by `connect()` and `applyChoice`, so
 * nothing in the type stops a red line rendering beside the neutral drop notice — and one
 * path reached exactly that. `components.css:737` states the rule the two would break
 * together: colour means *something needs a human, or something cannot be undone*. A
 * dropped plan needs one tap on Connect, and the notice is the whole explanation; an
 * error under it is either the failed apply of the plan being dropped, now moot, or the
 * teardown's own doing.
 *
 * A function here rather than a `setLastError(null)` alone, because the two are not the
 * same kind of guarantee and the provider needs both. `planWasDropped` is *derived* — true
 * on the very frame the drop becomes derivable — while a clear is a state write that lands
 * a render later, so one painted frame fits in between (a `merge` fails with a network
 * error, then another tab erases the book). This closes that frame. The clear is what
 * stops a merely hidden error resurfacing when something else moves the stage off
 * `dropped` without touching `lastError`, which the resume effect does.
 *
 * That second half is a claim about the provider, so it has to be true there: the clear is
 * keyed on `liveStage.kind === "dropped"` and sits *above* the commit effect's early
 * return, precisely so that a `DROPPED` written by `teardownConnection` — which
 * `afterLocalStateChange` passes through unchanged, making the transition a no-op — is
 * covered too. An earlier arrangement put it below, where it fired only for drops the
 * render derived; this comment asserted the guarantee anyway, and the PR review caught it.
 *
 * Only `dropped` suppresses. A `choosing` screen shows its apply failures — the choices
 * are still live and the user can retry one — and `idle` is the plain Connect row, where a
 * failed sign-in is the only thing the user has to go on.
 */
export function visibleError(stage: ConnectStage, lastError: string | null): string | null {
  return stage.kind === "dropped" ? null : lastError;
}
