import { openDB, type IDBPDatabase } from "idb";

export type WithDb = <T>(work: (db: IDBPDatabase) => Promise<T>) => Promise<T>;

/**
 * A lazily opened IndexedDB connection that is shared by every call until it stops being
 * usable, and then reopened.
 *
 * Both adapters used to cache the `openDB` promise for the life of the tab. Two things
 * end a connection while the tab keeps running, and a cached promise survived both:
 *
 * - **An open that rejected** (a database left at a newer version, a backing store the
 *   browser could not open). The rejected promise was handed back to every later call, so
 *   no retry could ever reach the database again.
 * - **The browser closing the connection itself** — DevTools deleting the database, site
 *   data cleared under an open tab. Every later transaction on it throws, so every load
 *   reported `STORAGE_UNAVAILABLE` and the recovery screen's Try again could not succeed
 *   until the page was reloaded. In the sync meta store it was worse than a stuck screen:
 *   reads came back as "not connected" and writes were swallowed, the
 *   `connected: false` that start-over and reset depend on included.
 *
 * Dropping the cached connection in both cases makes the next open a fresh one — the same
 * thing a reload does, and nothing more. A connection is dropped only if it is still the
 * cached one, so a late event from an old connection cannot discard a newer one.
 *
 * **Why `terminated` is not enough on its own.** The browser announces a forced close with
 * a `close` event that arrives asynchronously, so work issued in between still reaches the
 * dead connection and throws `InvalidStateError`. That error is taken as the same signal:
 * drop the connection and run the work once more on a fresh one. Once, so a database that
 * keeps refusing reports its failure instead of looping. Only safe because every caller's
 * work is idempotent — a get, a put of a whole value under one key, a delete of one key.
 * A transaction already under way when the browser force-closes the connection rejects with
 * `AbortError`, and this retry does not catch it. By the next call `terminated` has dropped
 * the cache. `AbortError` stays out of the retry: an ordinary abort uses the same name.
 */
export function createDbConnection(
  name: string,
  version: number,
  upgrade: (db: IDBPDatabase) => void,
): WithDb {
  let current: Promise<IDBPDatabase> | undefined;

  const drop = (connection: Promise<IDBPDatabase>) => {
    if (current === connection) current = undefined;
  };

  const getDb = (): Promise<IDBPDatabase> => {
    if (current) return current;
    const opening: Promise<IDBPDatabase> = openDB(name, version, {
      upgrade: (db) => upgrade(db),
      terminated: (): void => drop(opening),
    });
    current = opening;
    opening.catch(() => drop(opening));
    return opening;
  };

  return async (work) => {
    const connection = getDb();
    try {
      return await work(await connection);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "InvalidStateError") throw error;
      drop(connection);
      return work(await getDb());
    }
  };
}
