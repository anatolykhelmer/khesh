import "fake-indexeddb/auto";
import { createSyncMetaStore, EMPTY_SYNC_META } from "../../src/adapters/sync-meta-store";
import { trackConnections } from "../helpers/idb";

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
      joinedViaPicker: false,
    });
  });
  // A connection the browser closed under the tab must not stay cached. Reading it as
  // EMPTY_SYNC_META says "not connected" about a record that may say connected, and a save
  // through it is swallowed — the disconnect that start-over and reset rely on included.
  describe("after the browser closes the connection", () => {
    let tracked: ReturnType<typeof trackConnections>;
    beforeEach(() => {
      tracked = trackConnections();
    });
    afterEach(() => tracked.restore());

    it("load reopens and reads the stored record", async () => {
      const store = createSyncMetaStore(`t-${Math.random()}`);
      await store.save({ connected: true, fileId: "f1" });
      tracked.forceCloseAll();
      expect(await store.load()).toMatchObject({ connected: true, fileId: "f1" });
    });

    it("save reopens and writes", async () => {
      const name = `t-${Math.random()}`;
      const store = createSyncMetaStore(name);
      await store.save({ connected: true, fileId: "f1" });
      tracked.forceCloseAll();
      await store.save({ connected: false });
      expect(await createSyncMetaStore(name).load()).toMatchObject({ connected: false, fileId: "f1" });
    });
  });
});
