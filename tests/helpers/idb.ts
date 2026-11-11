import { forceCloseDatabase } from "fake-indexeddb";

/**
 * Records every connection `indexedDB.open` hands out from now on, so a test can close
 * them the way the browser does when a database is deleted from DevTools or site data is
 * cleared under an open tab: abruptly, with a `close` event, and with every later
 * transaction on that connection throwing.
 */
export function trackConnections() {
  const connections: IDBDatabase[] = [];
  const original = indexedDB.open;
  indexedDB.open = function (this: IDBFactory, ...args: Parameters<IDBFactory["open"]>) {
    const request = original.apply(this, args);
    request.addEventListener("success", () => connections.push(request.result));
    return request;
  };
  return {
    forceCloseAll() {
      // fake-indexeddb types the parameter as the IDBDatabase constructor; it takes an instance.
      type Connection = Parameters<typeof forceCloseDatabase>[0];
      for (const db of connections.splice(0)) forceCloseDatabase(db as unknown as Connection);
    },
    restore() {
      indexedDB.open = original;
    },
  };
}

export function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`deleting ${name} is blocked`));
  });
}

/** Leaves `name` at `version` with no stores, so an open at a lower version rejects. */
export function createAtVersion(name: string, version: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}
