import { openDB, type IDBPDatabase } from "idb";

export interface SyncMeta {
  connected: boolean;
  fileId: string | null;
  accountEmail: string | null;
  lastSyncAt: string | null;
}

export const EMPTY_SYNC_META: SyncMeta = {
  connected: false,
  fileId: null,
  accountEmail: null,
  lastSyncAt: null,
};

export interface SyncMetaStore {
  load(): Promise<SyncMeta>;
  save(patch: Partial<SyncMeta>): Promise<void>;
}

const STORE = "meta";
const KEY = "current";

/** Connection bookkeeping lives in its own tiny database so the ledger database's
 * schema version stays untouched. Reads and writes are best effort: losing this
 * record only means reconnecting, never losing book data. */
export function createSyncMetaStore(dbName = "khesh-sync"): SyncMetaStore {
  let dbPromise: Promise<IDBPDatabase> | undefined;
  const getDb = () => {
    if (!dbPromise) {
      dbPromise = openDB(dbName, 1, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        },
      });
    }
    return dbPromise;
  };

  return {
    async load(): Promise<SyncMeta> {
      try {
        const db = await getDb();
        const value = (await db.get(STORE, KEY)) as Partial<SyncMeta> | undefined;
        return { ...EMPTY_SYNC_META, ...value };
      } catch {
        return EMPTY_SYNC_META;
      }
    },
    async save(patch: Partial<SyncMeta>): Promise<void> {
      try {
        const db = await getDb();
        const current = ((await db.get(STORE, KEY)) as Partial<SyncMeta> | undefined) ?? {};
        await db.put(STORE, { ...EMPTY_SYNC_META, ...current, ...patch }, KEY);
      } catch {
        // best effort by design
      }
    },
  };
}
