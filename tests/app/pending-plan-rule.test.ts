import { describe, expect, it } from "vitest";
import { isPendingPlanStale } from "../../src/app/sync/pending-plan-rule";
import type { LocalState } from "../../src/service/sync-connect";

const ALL: LocalState[] = ["none", "empty", "real"];

describe("isPendingPlanStale", () => {
  it("has nothing to drop when no choice screen is open", () => {
    for (const local of ALL) expect(isPendingPlanStale(null, local)).toBe(false);
  });

  it("keeps a plan while the local state it was derived from still holds", () => {
    for (const local of ALL) {
      expect(isPendingPlanStale({ plannedFor: local }, local)).toBe(false);
    }
  });

  it("drops a plan derived from a book another tab has since reset away", () => {
    // The teardown race: connect() captured local "real" before awaiting inspectRemote,
    // fileIdRef is already bound to the user's real Drive file, and `pendingInspection`
    // was still null at the transition so shouldTearDown correctly did nothing. Without
    // this the screen offers "Upload this device's book" over the real one.
    expect(isPendingPlanStale({ plannedFor: "real" }, "none")).toBe(true);
    expect(isPendingPlanStale({ plannedFor: "empty" }, "none")).toBe(true);
  });

  it("drops a plan derived from no book once a book exists", () => {
    // Onboarding: "there is no Khesh book in your Drive yet, start one here first" is
    // false the moment Continue mints one. Recovery: a restored backup makes an offer to
    // "use the Drive book" an offer to replace what was just restored.
    expect(isPendingPlanStale({ plannedFor: "none" }, "empty")).toBe(true);
    expect(isPendingPlanStale({ plannedFor: "none" }, "real")).toBe(true);
  });

  it("drops a plan when a seeded book gains or loses its first real data", () => {
    // "empty" and "real" pick different choice sets — `merge` appears in exactly one of
    // them — so the two are as different as either is from "none".
    expect(isPendingPlanStale({ plannedFor: "empty" }, "real")).toBe(true);
    expect(isPendingPlanStale({ plannedFor: "real" }, "empty")).toBe(true);
  });

  it("is exactly inequality across every pair of local states", () => {
    for (const plannedFor of ALL) {
      for (const current of ALL) {
        expect(isPendingPlanStale({ plannedFor }, current)).toBe(plannedFor !== current);
      }
    }
  });
});
