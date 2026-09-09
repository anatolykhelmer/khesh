import { describe, expect, it } from "vitest";
import {
  firstConnectOptions,
  isChoiceOffered,
  type FirstConnectChoice,
  type LocalState,
  type RemoteInspection,
} from "../../src/service/sync-connect";

const EMPTY: RemoteInspection = { kind: "empty" };
const BOOK: RemoteInspection = { kind: "book", name: "Home", entryCount: 12 };
const INVALID: RemoteInspection = { kind: "unreadable", errorCode: "SYNC_ENVELOPE_INVALID" };
const NEWER: RemoteInspection = { kind: "unreadable", errorCode: "SYNC_FORMAT_UNSUPPORTED" };

const ALL_LOCAL: LocalState[] = ["none", "empty", "real"];
const ALL_CHOICES: FirstConnectChoice[] = ["useRemote", "replaceRemote", "merge"];

describe("firstConnectOptions — no local book", () => {
  it("explains rather than failing when Drive is empty", () => {
    expect(firstConnectOptions("none", EMPTY)).toEqual({ kind: "explain", reason: "remoteEmpty" });
  });

  it("offers taking the Drive book, and nothing else", () => {
    expect(firstConnectOptions("none", BOOK)).toEqual({ kind: "choose", choices: ["useRemote"] });
  });

  it("explains an unreadable remote, because there is no local book to overwrite it with", () => {
    expect(firstConnectOptions("none", INVALID)).toEqual({
      kind: "explain",
      reason: "remoteUnreadable",
    });
  });
});

describe("firstConnectOptions — a local book that holds no data", () => {
  it("uploads to an empty Drive without asking, as today", () => {
    expect(firstConnectOptions("empty", EMPTY)).toEqual({ kind: "apply", choice: "replaceRemote" });
  });

  it("never offers merge, because merging two seeds doubles the roots", () => {
    expect(firstConnectOptions("empty", BOOK)).toEqual({
      kind: "choose",
      choices: ["useRemote", "replaceRemote"],
    });
  });

  it("offers overwriting an unreadable remote", () => {
    expect(firstConnectOptions("empty", INVALID)).toEqual({
      kind: "choose",
      choices: ["replaceRemote"],
    });
  });
});

describe("firstConnectOptions — a real local book", () => {
  it("uploads to an empty Drive without asking, as today", () => {
    expect(firstConnectOptions("real", EMPTY)).toEqual({ kind: "apply", choice: "replaceRemote" });
  });

  it("offers all three, merge included", () => {
    expect(firstConnectOptions("real", BOOK)).toEqual({
      kind: "choose",
      choices: ["useRemote", "merge", "replaceRemote"],
    });
  });

  it("offers overwriting an unreadable remote", () => {
    expect(firstConnectOptions("real", INVALID)).toEqual({
      kind: "choose",
      choices: ["replaceRemote"],
    });
  });
});

describe("firstConnectOptions — a remote written by a newer app", () => {
  it("offers no action from any local state", () => {
    for (const local of ALL_LOCAL) {
      expect(firstConnectOptions(local, NEWER)).toEqual({ kind: "explain", reason: "updateApp" });
    }
  });
});

describe("firstConnectOptions — invariants across the whole table", () => {
  const REMOTES: RemoteInspection[] = [EMPTY, BOOK, INVALID, NEWER];

  it("offers merge in exactly one cell", () => {
    const merging = ALL_LOCAL.flatMap((local) =>
      REMOTES.map((remote) => ({ local, remote, plan: firstConnectOptions(local, remote) })),
    ).filter(({ plan }) => plan.kind === "choose" && plan.choices.includes("merge"));
    expect(merging).toHaveLength(1);
    expect(merging[0]!.local).toBe("real");
    expect(merging[0]!.remote).toEqual(BOOK);
  });

  it("never offers an action that needs a local book when there is none", () => {
    for (const remote of REMOTES) {
      const plan = firstConnectOptions("none", remote);
      if (plan.kind === "apply") {
        expect(plan.choice).toBe("useRemote");
      }
      if (plan.kind === "choose") {
        expect(plan.choices).not.toContain("replaceRemote");
        expect(plan.choices).not.toContain("merge");
      }
    }
  });
});

describe("isChoiceOffered", () => {
  it("accepts exactly the choices a choose plan lists", () => {
    const plan = firstConnectOptions("real", BOOK);
    expect(isChoiceOffered(plan, "useRemote")).toBe(true);
    expect(isChoiceOffered(plan, "merge")).toBe(true);
    expect(isChoiceOffered(plan, "replaceRemote")).toBe(true);

    const seeded = firstConnectOptions("empty", BOOK);
    expect(isChoiceOffered(seeded, "merge")).toBe(false);
  });

  it("accepts nothing once the screen is gone", () => {
    for (const choice of ALL_CHOICES) {
      expect(isChoiceOffered(null, choice)).toBe(false);
    }
  });

  it("accepts nothing from a plan that only explains", () => {
    const plan = firstConnectOptions("none", EMPTY);
    for (const choice of ALL_CHOICES) {
      expect(isChoiceOffered(plan, choice)).toBe(false);
    }
  });

  it("accepts an apply plan's own choice and no other", () => {
    const plan = firstConnectOptions("real", EMPTY);
    expect(isChoiceOffered(plan, "replaceRemote")).toBe(true);
    expect(isChoiceOffered(plan, "useRemote")).toBe(false);
    expect(isChoiceOffered(plan, "merge")).toBe(false);
  });
});
