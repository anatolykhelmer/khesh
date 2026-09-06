import "fake-indexeddb/auto";
import { createSyncMetaStore, EMPTY_SYNC_META } from "../../src/adapters/sync-meta-store";

describe("sync meta store", () => {
  it("returns EMPTY_SYNC_META when nothing is stored", async () => {
    const store = createSyncMetaStore(`t-${Math.random()}`);
    expect(await store.load()).toEqual(EMPTY_SYNC_META);
  });

  it("merge-saves patches", async () => {
    const store = createSyncMetaStore(`t-${Math.random()}`);
    await store.save({ connected: true, fileId: "f1" });
    await store.save({ lastSyncAt: "2026-09-02T10:00:00.000Z" });
    expect(await store.load()).toEqual({
      connected: true,
      fileId: "f1",
      accountEmail: null,
      lastSyncAt: "2026-09-02T10:00:00.000Z",
    });
  });
});
