import { describe, expect, it } from "vitest";
import { err, ok } from "../../src/kernel/result";
import { performReset, type ResetDeps } from "../../src/app/reset-flow";

/** Builds ResetDeps whose sync/resetAll/announce push into one shared `calls` array, so
 * tests can assert relative order — not merely that each step ran. */
function tracked(overrides?: {
  connected?: boolean;
  pendingInspection?: unknown;
  disconnect?: () => Promise<void>;
  resetAll?: () => Promise<ReturnType<typeof ok<void>> | ReturnType<typeof err<void>>>;
}) {
  const calls: string[] = [];
  const errors: (string | null)[] = [];
  const announced: unknown[] = [];

  const deps: ResetDeps = {
    sync: {
      connected: overrides?.connected ?? false,
      pendingInspection: overrides?.pendingInspection ?? null,
      disconnect:
        overrides?.disconnect ??
        (async () => {
          calls.push("disconnect");
        }),
    },
    resetAll:
      overrides?.resetAll ??
      (async () => {
        calls.push("erase");
        return ok(undefined);
      }),
    announceBookChanged: (book) => {
      calls.push("announce");
      announced.push(book);
    },
    setError: (message) => {
      errors.push(message);
    },
  };

  return { deps, calls, errors, announced };
}

describe("performReset", () => {
  it("disconnects before erasing, and erases before announcing", async () => {
    const { deps, calls } = tracked({ connected: true });
    await performReset(deps);
    expect(calls).toEqual(["disconnect", "erase", "announce"]);
  });

  it("tears down a pending first-connect choice even though connected is false", async () => {
    const { deps, calls } = tracked({ connected: false, pendingInspection: { kind: "book" } });
    await performReset(deps);
    expect(calls).toEqual(["disconnect", "erase", "announce"]);
  });

  it("skips disconnect entirely when sync is idle", async () => {
    const { deps, calls } = tracked({ connected: false, pendingInspection: null });
    await performReset(deps);
    expect(calls).toEqual(["erase", "announce"]);
  });

  it("surfaces the error and does not announce when resetAll fails", async () => {
    const { deps, calls, errors, announced } = tracked({
      connected: true,
      resetAll: async () => {
        calls.push("erase");
        return err("STORAGE_WRITE_FAILED", "disk full");
      },
    });
    await performReset(deps);
    expect(calls).toEqual(["disconnect", "erase"]);
    expect(announced).toEqual([]);
    expect(errors.at(-1)).not.toBeNull();
  });

  it("announces null and clears the error on success", async () => {
    const { deps, errors, announced } = tracked({ connected: true });
    await performReset(deps);
    expect(announced).toEqual([null]);
    expect(errors.at(-1)).toBeNull();
  });
});
