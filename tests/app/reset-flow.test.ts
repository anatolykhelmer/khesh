import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createIndexedDbRepository } from "../../src/adapters/indexeddb-repository";
import { createSyncMetaStore } from "../../src/adapters/sync-meta-store";
import { createBook } from "../../src/kernel/create-book";
import { err, ok } from "../../src/kernel/result";
import { performReset, performStartOver, type ResetDeps } from "../../src/app/reset-flow";
import { NOW, unwrap } from "../helpers";

/** Builds ResetDeps whose sync/resetAll/announce push into one shared `calls` array, so
 * tests can assert relative order — not merely that each step ran. */
function tracked(overrides?: {
  disconnect?: () => Promise<void>;
  resetAll?: () => Promise<ReturnType<typeof ok<void>> | ReturnType<typeof err<void>>>;
  beginErase?: () => void;
  endErase?: () => void;
}) {
  const calls: string[] = [];
  const errors: (string | null)[] = [];
  const announced: unknown[] = [];

  const deps: ResetDeps = {
    sync: {
      disconnect:
        overrides?.disconnect ??
        (async () => {
          calls.push("disconnect");
        }),
      cancelConnect: () => {
        calls.push("cancelConnect");
      },
      beginErase: overrides?.beginErase ?? (() => {}),
      endErase: overrides?.endErase ?? (() => {}),
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
    const { deps, calls } = tracked();
    await performReset(deps);
    expect(calls).toEqual(["disconnect", "erase", "cancelConnect", "announce"]);
  });

  it("disconnects unconditionally, because an idle-looking snapshot is not an idle session", async () => {
    // The Important finding on PR #7, and the sequence half of its pin. This used to ask
    // `if (connected || pendingInspection !== null)` first, and both are a React snapshot —
    // a photograph of something that can still become true. A tab at boot has started
    // `resumeStoredConnection` and its `metaStore.load()` has not landed, so `connected` is
    // false and there is no inspection; erase in there and the gate read quiet, nothing
    // wrote `connected: false`, and `resetAll` does not touch `sync-meta`. The resume then
    // refuses (for `erasing`, then for the null book), a refusal is deliberately not an
    // answer, and the retry the wizard's fresh seed triggers loads a record still saying
    // connected, adopts the old `fileId`, and pulls the Drive book back over the seed. The
    // user erased their book and it came back.
    //
    // `ResetSyncDeps` no longer carries either field, so the gate cannot return without a
    // type change — `performStartOver`'s own discipline, for the same class of hole. This
    // test is what fails if a gate is reintroduced through some other reading of the
    // session; `tracked()` stubs a session with nothing live in it at all.
    const { deps, calls } = tracked();
    await performReset(deps);
    expect(calls[0]).toBe("disconnect");
  });

  it("ends the first-connect flow with one write that needs no port", async () => {
    // `cancelConnect` used to be the *only* thing that cleared a dropped-plan notice here:
    // `dropped` is neither `connected` nor a `pendingInspection`, so the old gate skipped
    // the teardown, and `dropped` is terminal so nothing else recomputed it. With the
    // disconnect unconditional, `afterTeardown(stage, { cause: "userAction" })` answers
    // `IDLE` from every stage and already clears it — which is why `performStartOver`
    // carries no `cancelConnect` at all. What this still pins is the ordering: the clear
    // lands before the announce that opens onboarding, so the sentence "the book on this
    // device changed, so those options no longer apply" cannot ride onto a screen about a
    // book that no longer exists.
    const { deps, calls } = tracked();
    await performReset(deps);
    expect(calls).toContain("cancelConnect");
    expect(calls.indexOf("cancelConnect")).toBeLessThan(calls.indexOf("announce"));
  });

  it("does not reach its own cancelConnect when the erase failed", async () => {
    // Placement, not outcome — and the difference is worth stating, because it used to be
    // the outcome. Nothing was erased, so this function does not go on to clear the screen
    // itself; but the unconditional `disconnect()` at the top has already run its teardown,
    // and that clears the notice regardless. The notice no longer survives a failed erase.
    // (It already did not whenever anything was connected; it is now true always.)
    const { deps, calls } = tracked({
      resetAll: async () => {
        calls.push("erase");
        return err("STORAGE_WRITE_FAILED", "disk full");
      },
    });
    await performReset(deps);
    expect(calls).not.toContain("cancelConnect");
  });

  it("surfaces a disconnect failure and erases nothing", async () => {
    // Untested until the disconnect became unconditional, and reachable on every erase now
    // rather than only on a connected one. `SyncSession.disconnect` swallows its own
    // failures, so this is about what happens if that ever stops being true: the erase must
    // not proceed on a teardown whose outcome is unknown — a live engine against
    // newly-empty storage is BL-040 itself — and the user must see a banner rather than a
    // button that did nothing.
    const { deps, calls, errors, announced } = tracked({
      disconnect: async () => {
        throw new Error("revoke exploded");
      },
    });
    await performReset(deps);
    expect(calls).toEqual([]);
    expect(announced).toEqual([]);
    expect(errors.at(-1)).not.toBeNull();
  });

  it("surfaces the error and does not announce when resetAll fails", async () => {
    const { deps, calls, errors, announced } = tracked({
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
    const { deps, errors, announced } = tracked();
    await performReset(deps);
    expect(announced).toEqual([null]);
    expect(errors.at(-1)).toBeNull();
  });

  it("holds the erase flag for the whole sequence, including after disconnect resolves", async () => {
    // Own local `calls`, distinct from `tracked()`'s internal one: the point is the
    // relative order of exactly the four steps this test overrides, not the full
    // sequence `tracked()`'s own defaults (`cancelConnect`, `announceBookChanged`)
    // would otherwise add to it.
    const calls: string[] = [];
    const { deps } = tracked({
      beginErase: () => calls.push("begin"),
      endErase: () => calls.push("end"),
      disconnect: async () => {
        calls.push("disconnect");
      },
      resetAll: async () => {
        calls.push("resetAll");
        return ok(undefined);
      },
    });
    await performReset(deps);
    expect(calls).toEqual(["begin", "disconnect", "resetAll", "end"]);
  });
});

describe("performStartOver", () => {
  /** Same shape as `tracked` above: one shared array, so order is assertable. */
  function trackedStartOver(disconnect?: () => Promise<void>) {
    const calls: string[] = [];
    const errors: (string | null)[] = [];
    const deps = {
      sync: {
        disconnect:
          disconnect ??
          (async () => {
            calls.push("disconnect");
          }),
      },
      startOver: () => {
        calls.push("startOver");
      },
      setError: (message: string | null) => {
        errors.push(message);
      },
    };
    return { deps, calls, errors };
  }

  it("disconnects Drive before clearing the boot error", async () => {
    const { deps, calls } = trackedStartOver();
    await performStartOver(deps);
    expect(calls).toEqual(["disconnect", "startOver"]);
  });

  it("disconnects unconditionally, because the connection that matters is the stored one", async () => {
    // The flag that brings the old book back with doubled roots is `meta.connected` in
    // the sync-meta database, and `useSync()` does not report it here: the resume effect
    // is gated on `book !== null`, so it never runs while a book has failed to load and
    // `connected` stays false however the stored record reads. A `performReset`-style
    // "is there anything to disconnect?" gate would find it quiet and skip the write.
    // (`pendingInspection` is a separate matter — this screen renders `ConnectDrive`, so
    // it can be non-null. That is one more thing to tear down, not a reason to gate.)
    // `StartOverDeps` carries neither field; this test is what fails if they are consulted.
    const { deps, calls } = trackedStartOver();
    await performStartOver(deps);
    expect(calls).toContain("disconnect");
  });

  it("surfaces a disconnect failure and stays on the recovery screen", async () => {
    const { deps, calls, errors } = trackedStartOver(async () => {
      throw new Error("revoke exploded");
    });
    await performStartOver(deps);
    expect(calls).toEqual([]);
    expect(errors.at(-1)).not.toBeNull();
  });

  it("clears the error banner on success", async () => {
    const { deps, errors } = trackedStartOver();
    await performStartOver(deps);
    expect(errors.at(-1)).toBeNull();
  });

  it("drops the stored Drive connection and leaves the stored book exactly where it was", async () => {
    // The safety property in one place: start over ends the connection that would
    // resurrect the old book, and erases nothing. Close the tab here and the recovery
    // screen comes back with the book still in storage — the overwrite happens only when
    // onboarding's Continue finishes building its replacement.
    const repo = createIndexedDbRepository("khesh-start-over-safety");
    const stored = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    unwrap(await repo.save(stored));

    const meta = createSyncMetaStore("khesh-start-over-safety-meta");
    await meta.save({ connected: true, fileId: "drive-file-1", accountEmail: "a@b.c" });

    let cleared = false;
    await performStartOver({
      sync: {
        disconnect: async () => {
          await meta.save({ connected: false, fileId: null, accountEmail: null });
        },
      },
      startOver: () => {
        cleared = true;
      },
      setError: () => {},
    });

    expect((await meta.load()).connected).toBe(false);
    expect(cleared).toBe(true);
    expect(unwrap(await repo.load())).toEqual(stored);
  });
});
