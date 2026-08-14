import { openDB, type IDBPDatabase } from "idb";
import { err, ok, type Result } from "../kernel/result";
import type { Book } from "../kernel/types";
import { validateBook } from "../kernel/validate";
import type { LedgerRepository } from "../ports/ledger-repository";

const STORE = "books";
const KEY = "current";

export function createIndexedDbRepository(dbName = "khesh-ledger"): LedgerRepository {
  let dbPromise: Promise<IDBPDatabase> | undefined;

  const getDb = () => {
    if (!dbPromise) {
      dbPromise = openDB(dbName, 1, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE);
          }
        },
      });
    }
    return dbPromise;
  };

  return {
    async load(): Promise<Result<Book | null>> {
      try {
        const db = await getDb();
        const value = await db.get(STORE, KEY);
        if (value === undefined) return ok(null);
        const validated = validateBook(value as Book);
        if (!validated.ok) return validated;
        return ok(value as Book);
      } catch {
        return err("STORAGE_UNAVAILABLE", "Failed to read IndexedDB");
      }
    },
    async save(book: Book): Promise<Result<void>> {
      try {
        const db = await getDb();
        await db.put(STORE, book, KEY);
        return ok(undefined);
      } catch {
        return err("STORAGE_WRITE_FAILED", "Failed to write IndexedDB");
      }
    },
  };
}
