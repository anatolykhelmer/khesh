import { describe, expect, it } from "vitest";
import {
  afterLocalStateChange,
  afterTeardown,
  DROPPED,
  IDLE,
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
  it("closes a live choice screen", () => {
    for (const local of ALL) {
      expect(afterTeardown(choosing(local))).toBe(IDLE);
    }
  });

  it("keeps a drop notice the teardown's own late cleanup would otherwise eat", () => {
    // Both fire on the flush where another tab's reset nulls the book: the teardown
    // effect first (it reads the raw stage), the drop a beat later. teardownConnection
    // then finishes three awaits and clears the stage — after the notice appeared.
    expect(afterTeardown(DROPPED)).toBe(DROPPED);
  });

  it("leaves an idle stage alone", () => {
    expect(afterTeardown(IDLE)).toBe(IDLE);
  });
});
