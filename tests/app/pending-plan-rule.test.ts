import { describe, expect, it } from "vitest";
import {
  afterLocalStateChange,
  afterTeardown,
  DROPPED,
  IDLE,
  teardownStillApplies,
  visibleError,
  type ConnectStage,
} from "../../src/app/sync/pending-plan-rule";
import type { LocalState } from "../../src/service/sync-connect";

const ALL: LocalState[] = ["none", "empty", "real"];

/** A choice screen stamped with the local state its plan was derived from. The inspection
 * and plan are the smallest values that satisfy their types: no rule here reads them. */
function choosing(plannedFor: LocalState): ConnectStage {
  return {
    kind: "choosing",
    inspection: { kind: "empty" },
    plan: { kind: "explain", reason: "remoteEmpty" },
    plannedFor,
  };
}

describe("afterLocalStateChange", () => {
  it("has nothing to drop when no choice screen is open", () => {
    for (const local of ALL) {
      expect(afterLocalStateChange(IDLE, local, false)).toBe(IDLE);
    }
  });

  it("keeps a plan while the local state it was derived from still holds", () => {
    for (const local of ALL) {
      const stage = choosing(local);
      expect(afterLocalStateChange(stage, local, false)).toBe(stage);
    }
  });

  it("drops a plan derived from a book another tab has since reset away", () => {
    // The teardown race: connect() captured local "real" before awaiting inspectRemote,
    // fileIdRef is already bound to the user's real Drive file, and the stage was still
    // idle at the transition so shouldTearDown correctly did nothing. Without this the
    // screen offers "Upload this device's book" over the real one.
    expect(afterLocalStateChange(choosing("real"), "none", false)).toBe(DROPPED);
    expect(afterLocalStateChange(choosing("empty"), "none", false)).toBe(DROPPED);
  });

  it("drops a plan derived from no book once a book exists", () => {
    // Onboarding: "there is no Khesh book in your Drive yet, start one here first" is
    // false the moment Continue mints one. Recovery: a restored backup makes an offer to
    // "use the Drive book" an offer to replace what was just restored.
    expect(afterLocalStateChange(choosing("none"), "empty", false)).toBe(DROPPED);
    expect(afterLocalStateChange(choosing("none"), "real", false)).toBe(DROPPED);
  });

  it("drops a plan when a seeded book gains or loses its first real data", () => {
    // "empty" and "real" pick different choice sets — `merge` appears in exactly one of
    // them — so the two are as different as either is from "none".
    expect(afterLocalStateChange(choosing("empty"), "real", false)).toBe(DROPPED);
    expect(afterLocalStateChange(choosing("real"), "empty", false)).toBe(DROPPED);
  });

  it("is exactly inequality across every pair of local states", () => {
    for (const plannedFor of ALL) {
      for (const current of ALL) {
        const stage = choosing(plannedFor);
        expect(afterLocalStateChange(stage, current, false)).toBe(
          plannedFor === current ? stage : DROPPED,
        );
      }
    }
  });

  it("drops nothing while the user's own choice is being applied", () => {
    // applyChoice("useRemote") replaces the book, so localState moves and the plan goes
    // stale *by succeeding* — and finalizeConnect then awaits a network round trip for
    // the account email before it clears the stage. Without this clause the screen would
    // announce "the book on this device changed, connect again" over a choice that is
    // completing successfully, for the length of an HTTP request.
    for (const plannedFor of ALL) {
      for (const current of ALL) {
        const stage = choosing(plannedFor);
        expect(afterLocalStateChange(stage, current, true)).toBe(stage);
      }
    }
  });

  it("does not resurrect a dropped plan when the book returns to what it was", () => {
    // Onboarding's Continue then a start-over lands back on "none". The old boolean rule
    // recomputed staleness from plannedFor !== localState, so it would have called the
    // plan fresh again — a plan derived from a Drive read two transitions old.
    for (const local of ALL) {
      expect(afterLocalStateChange(DROPPED, local, false)).toBe(DROPPED);
      expect(afterLocalStateChange(DROPPED, local, true)).toBe(DROPPED);
    }
  });
});

describe("afterTeardown", () => {
  /** The vanished-book intent as `SyncProvider`'s effect builds it: the stage of the
   * render that decided to tear down. Every assertion below has to name it, because the
   * plan a teardown may drop is the plan it started from and no other. */
  function vanished(startedFrom: ConnectStage) {
    return { cause: "bookVanished", startedFrom } as const;
  }

  it("closes a live choice screen the user themselves ended", () => {
    // Disconnect, the Settings reset, start over: the choices are gone because the user
    // said so, and there is nothing to explain.
    for (const local of ALL) {
      expect(afterTeardown(choosing(local), { cause: "userAction" })).toBe(IDLE);
    }
  });

  it("turns a live choice screen into the notice when the book vanished under it", () => {
    // Another tab's reset nulls the book, teardownConnection drops the store, auth and
    // file id the choices would have acted on. Clearing to IDLE here is BL-050's exact
    // silence: the screen collapses to a plain Connect row that looks untouched.
    for (const local of ALL) {
      const stage = choosing(local);
      expect(afterTeardown(stage, vanished(stage))).toBe(DROPPED);
    }
  });

  it("does not need the staleness drop to have been committed first", () => {
    // The case that broke when this took no cause. The book vanishes while the user's
    // own choice is being applied, so afterLocalStateChange suppresses the drop on that
    // flush — nothing is ever committed — and the teardown is the only writer left. It
    // used to find `choosing` and write IDLE, leaving the user with the raw "sync is not
    // connected" that the apply then failed with, and nothing saying why.
    const stage = choosing("real");
    const suppressed = afterLocalStateChange(stage, "none", true);
    // The suppression returns its input, so the plan the teardown started from is still
    // the plan on screen — which is exactly why identity lets this one through.
    expect(suppressed).toBe(stage);
    expect(afterTeardown(suppressed, vanished(stage))).toBe(DROPPED);
  });

  it("leaves alone a plan that was decided after the teardown began", () => {
    // The reviewer's case, and the reason the intent carries a stage at all. This tail
    // runs after three awaits — `revoke()` is a network round trip with no timeout of its
    // own — while `connect()` is free the whole time, recreating the auth and store the
    // teardown nulled. So a second Connect can land a plan decided from the local state
    // the vanished book left behind: valid, current, and none of this teardown's
    // business. Answering DROPPED here would print BL-050's notice over live choices.
    const startedFrom = choosing("real");
    const decidedAfter = choosing("none");
    expect(afterTeardown(decidedAfter, vanished(startedFrom))).toBe(decidedAfter);
  });

  it("tells two plans apart by identity, not by the local state they were planned for", () => {
    // A `choosing` that merely *looks* like the one the teardown started from is still a
    // different plan, carrying a different inspection of Drive. Kills the mutant that
    // compares `plannedFor`, or `kind`, instead of the object.
    for (const local of ALL) {
      const startedFrom = choosing(local);
      const lookalike = choosing(local);
      expect(afterTeardown(lookalike, vanished(startedFrom))).toBe(lookalike);
      expect(afterTeardown(startedFrom, vanished(startedFrom))).toBe(DROPPED);
    }
  });

  it("keeps a notice through the teardown that caused it", () => {
    // The drop did commit first here — the ordering the old rule assumed always held.
    // Both orders now reach the same stage, and the commit effect got here first, so the
    // stage no longer matches `startedFrom` and this simply leaves it standing.
    expect(afterTeardown(DROPPED, vanished(choosing("real")))).toBe(DROPPED);
    expect(afterTeardown(DROPPED, vanished(DROPPED))).toBe(DROPPED);
  });

  it("retires a notice the user's own erase has made irrelevant", () => {
    // performStartOver disconnects unconditionally, so this is the whole of its guard
    // against carrying "the book on this device changed…" onto the fresh onboarding
    // screen it is one line from opening.
    expect(afterTeardown(DROPPED, { cause: "userAction" })).toBe(IDLE);
  });

  it("leaves an idle stage alone, whichever end of the connection it came from", () => {
    // The bookVanished half matters: that effect also fires for a plain connected tab
    // with no plan pending (BL-040's case), and a rule that answered DROPPED for every
    // vanished book would put the notice on a screen where no choices were ever offered.
    // `startedFrom` is IDLE here, so identity alone would match — the `kind` check beside
    // it is what keeps the notice off a screen that never offered choices.
    expect(afterTeardown(IDLE, { cause: "userAction" })).toBe(IDLE);
    expect(afterTeardown(IDLE, vanished(IDLE))).toBe(IDLE);
  });

  it("is exactly the started-from plan and nothing else, across the whole table", () => {
    // The truth table with identity folded in. `userAction` clears every stage; a vanished
    // book drops the one stage the teardown named and returns every other unchanged. A
    // mutant that inverts the identity test fails the diagonal; one that drops it fails
    // everywhere off the diagonal.
    const plans = ALL.map(choosing);
    const stages: ConnectStage[] = [IDLE, DROPPED, ...plans];
    for (const startedFrom of stages) {
      for (const current of stages) {
        expect(afterTeardown(current, { cause: "userAction" })).toBe(IDLE);
        const dropped = current.kind === "choosing" && current === startedFrom;
        expect(afterTeardown(current, vanished(startedFrom))).toBe(dropped ? DROPPED : current);
      }
    }
  });
});

describe("visibleError", () => {
  // Whatever `errorMessage(code)` would have produced. The rule never reads the string.
  const RED = "Sync is not connected";

  it("shows a failed apply beside the choices it belongs to", () => {
    // The choice screen is still live and the user can retry — this is the one place a
    // red line under the choices is the right answer.
    for (const local of ALL) {
      expect(visibleError(choosing(local), RED)).toBe(RED);
    }
  });

  it("shows a failed sign-in on the plain Connect row", () => {
    // `idle` is the collapsed row with no notice on it. A dismissed or blocked Google
    // popup leaves this error as the only thing the user has to go on; suppressing it
    // here would be "Connect looks like it did nothing", which is BL-050's own complaint.
    expect(visibleError(IDLE, RED)).toBe(RED);
  });

  it("keeps colour off the row the drop notice is on", () => {
    // components.css:737 — colour means something needs a human or cannot be undone. A
    // dropped plan needs one tap on Connect, and the notice says so. The error that would
    // land under it is the moot failure of the plan being dropped, or the teardown's own.
    expect(visibleError(DROPPED, RED)).toBe(null);
  });

  it("never lets the notice and a red line render together, for any stage or error", () => {
    // The invariant stated directly, since `lastError` is not part of `ConnectStage` and
    // the type cannot state it. The suppression is what closes the *frame*: `planWasDropped`
    // is derived and true immediately, while the provider's `setLastError(null)` is a state
    // write that lands a render later, and a paint fits in between — a `merge` fails with a
    // network error, then another tab erases the book.
    const stages: ConnectStage[] = [IDLE, DROPPED, ...ALL.map(choosing)];
    for (const stage of stages) {
      for (const error of [null, RED, ""]) {
        const planWasDropped = stage.kind === "dropped";
        const shown = visibleError(stage, error);
        expect(planWasDropped && shown !== null).toBe(false);
        // And nothing else is touched: every stage that is not `dropped` passes it through.
        if (!planWasDropped) expect(shown).toBe(error);
      }
    }
  });

  it("has nothing to suppress when there is no error", () => {
    // Pins the null case separately, so a mutant returning some sentinel instead of the
    // input cannot hide behind the table above.
    expect(visibleError(DROPPED, null)).toBe(null);
    expect(visibleError(IDLE, null)).toBe(null);
    expect(visibleError(choosing("real"), null)).toBe(null);
  });
});

describe("teardownStillApplies", () => {
  const ERASE = { cause: "userAction" } as const;
  const VANISHED = { cause: "bookVanished", startedFrom: choosing("real") } as const;

  it("lets a connect made after a vanished book overrule the teardown", () => {
    // The drop notice asks the user to tap Connect, and `revoke()` is a network round trip
    // with no timeout of its own, so that tap can land inside the teardown's own window. A
    // connect that reached `finalizeConnect` has written `connected: true`; the tail's
    // "disconnected" would leave a live engine and live refs under an app that says it is
    // disconnected — persisted, so the next boot resumes nothing.
    expect(teardownStillApplies(VANISHED, 3, 4)).toBe(false);
  });

  it("keeps a vanished-book teardown when nothing connected underneath it", () => {
    // The ordinary case, and the one that must not be broken by the clause above.
    expect(teardownStillApplies(VANISHED, 0, 0)).toBe(true);
    expect(teardownStillApplies(VANISHED, 7, 7)).toBe(true);
  });

  it("never lets a connect overrule an erase the user asked for", () => {
    // The asymmetry this function exists for. `performReset` erases the book next and
    // `performStartOver` opens onboarding, so a connect that won here leaves `connected:
    // true` persisted with a live engine on the real Drive file while the book is null —
    // and onboarding's Continue then merges a fresh seed against the real remote. BL-040,
    // the failure these two flows exist to prevent.
    expect(teardownStillApplies(ERASE, 3, 4)).toBe(true);
    expect(teardownStillApplies(ERASE, 0, 9)).toBe(true);
  });

  it("does not fall back on the teardown effect to undo a skipped erase", () => {
    // Why the clause above cannot be left to self-correct. The teardown effect writes
    // `previousBookRef.current = book` on every run, so a run that sees the book go null
    // while `connected` is still false consumes the transition — and `shouldTearDown`
    // needs `previous` to be non-null, so it can never fire for that erase again. Pinned
    // as a truth about the pair: the answer for `userAction` does not depend on the counts
    // at all, which is what makes it independent of that timing.
    for (const [start, now] of [[0, 0], [1, 2], [5, 5], [2, 99]] as const) {
      expect(teardownStillApplies(ERASE, start, now)).toBe(true);
    }
  });

  it("asks whether the count differs, not which way", () => {
    // `connectionGenerationRef` only ever increments, so `>=` and `===` agree on every
    // input the provider can produce and this case is unreachable today — which is exactly
    // why it is worth pinning. A future edit that resets the ref (on unmount, on a
    // disconnect) would make `>=` answer "still applies" for a teardown that a live
    // connection had superseded, and nothing else in this file would notice.
    expect(teardownStillApplies(VANISHED, 5, 3)).toBe(false);
  });

  it("is exactly the cause crossed with whether a connection landed", () => {
    // The table. A mutant that drops the cause check fails the `userAction` row; one that
    // swaps the causes fails both; one that answers a constant fails one row entirely.
    for (const [start, now] of [[0, 0], [4, 4], [0, 1], [4, 9], [9, 4]] as const) {
      expect(teardownStillApplies(ERASE, start, now)).toBe(true);
      expect(teardownStillApplies(VANISHED, start, now)).toBe(start === now);
    }
  });
});
