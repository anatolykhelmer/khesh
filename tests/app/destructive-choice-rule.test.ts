import { describe, expect, it } from "vitest";
import { needsConfirmation } from "../../src/app/sync/destructive-choice-rule";
import type {
  FirstConnectChoice,
  LocalState,
  RemoteInspection,
} from "../../src/service/sync-connect";

const EMPTY: RemoteInspection = { kind: "empty" };
const BOOK: RemoteInspection = { kind: "book", name: "Home", entryCount: 12 };
const INVALID: RemoteInspection = { kind: "unreadable", errorCode: "SYNC_ENVELOPE_INVALID" };

const ALL_LOCAL: LocalState[] = ["none", "empty", "real"];
const ALL_REMOTE: RemoteInspection[] = [EMPTY, BOOK, INVALID];

describe("needsConfirmation — replaceRemote", () => {
  it("asks before overwriting a readable Drive book, from every local state", () => {
    for (const local of ALL_LOCAL) {
      expect(needsConfirmation("replaceRemote", BOOK, local)).toBe(true);
    }
  });

  it("does not ask when the remote holds nothing to lose", () => {
    for (const local of ALL_LOCAL) {
      expect(needsConfirmation("replaceRemote", EMPTY, local)).toBe(false);
      expect(needsConfirmation("replaceRemote", INVALID, local)).toBe(false);
    }
  });
});

describe("needsConfirmation — useRemote", () => {
  it("asks when a real local book would be thrown away", () => {
    for (const remote of ALL_REMOTE) {
      expect(needsConfirmation("useRemote", remote, "real")).toBe(true);
    }
  });

  it("does not ask when the local side is a seed or absent", () => {
    for (const remote of ALL_REMOTE) {
      expect(needsConfirmation("useRemote", remote, "empty")).toBe(false);
      expect(needsConfirmation("useRemote", remote, "none")).toBe(false);
    }
  });
});

describe("needsConfirmation — merge", () => {
  it("never asks, because it deletes neither side", () => {
    for (const local of ALL_LOCAL) {
      for (const remote of ALL_REMOTE) {
        expect(needsConfirmation("merge", remote, local)).toBe(false);
      }
    }
  });
});

describe("needsConfirmation — across the table", () => {
  const ALL_CHOICES: FirstConnectChoice[] = ["useRemote", "replaceRemote", "merge"];

  it("asks in exactly the cells where one side's data is deleted", () => {
    const asking = ALL_CHOICES.flatMap((choice) =>
      ALL_LOCAL.flatMap((local) =>
        ALL_REMOTE.map((remote) => ({ choice, local, remote })),
      ),
    ).filter(({ choice, local, remote }) => needsConfirmation(choice, remote, local));

    expect(asking).toEqual([
      { choice: "useRemote", local: "real", remote: EMPTY },
      { choice: "useRemote", local: "real", remote: BOOK },
      { choice: "useRemote", local: "real", remote: INVALID },
      { choice: "replaceRemote", local: "none", remote: BOOK },
      { choice: "replaceRemote", local: "empty", remote: BOOK },
      { choice: "replaceRemote", local: "real", remote: BOOK },
    ]);
  });
});
