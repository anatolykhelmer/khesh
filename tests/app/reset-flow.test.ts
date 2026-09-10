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
      cancelConnect: () => {
        calls.push("cancelConnect");
      },
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
    expect(calls).toEqual(["disconnect", "erase", "cancelConnect", "announce"]);
  });

  it("tears down a pending first-connect choice even though connected is false", async () => {
    const { deps, calls } = tracked({ connected: false, pendingInspection: { kind: "book" } });
    await performReset(deps);
    expect(calls).toEqual(["disconnect", "erase", "cancelConnect", "announce"]);
  });

  it("skips disconnect entirely when sync is idle", async () => {
    const { deps, calls } = tracked({ connected: false, pendingInspection: null });
    await performReset(deps);
    expect(calls).toEqual(["erase", "cancelConnect", "announce"]);
  });

  it("ends the first-connect flow even where there is no connection to tear down", async () => {
    // A dropped-plan notice is neither `connected` nor a `pendingInspection`, so the gate
    // above skips the teardown that would otherwise have cleared it — and `dropped` is
    // terminal, so nothing else recomputes it. Without this call the sentence "the book on
    // this device changed while Google Drive was being read" rides the erase onto the
    // onboarding screen the next line opens, describing a book that no longer exists.
    const { deps, calls } = tracked({ connected: false, pendingInspection: null });
    await performReset(deps);
    expect(calls).toContain("cancelConnect");
    expect(calls.indexOf("cancelConnect")).toBeLessThan(calls.indexOf("announce"));
  });

  it("leaves the first-connect flow alone when the erase failed", async () => {
    // Nothing was erased, so every reason the notice went up still holds.
    const { deps, calls } = tracked({
      connected: false,
      pendingInspection: null,
      resetAll: async () => {
        calls.push("erase");
        return err("STORAGE_WRITE_FAILED", "disk full");
      },
    });
    await performReset(deps);
    expect(calls).not.toContain("cancelConnect");
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
