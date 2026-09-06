import { openDB, type IDBPDatabase } from "idb";
import { err, ok, type Result } from "../kernel/result";
import type { Book } from "../kernel/types";
import { validateBook } from "../kernel/validate";
import { normalizeBook, type StoredBook } from "../kernel/normalize";
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
        const book = normalizeBook(value as StoredBook);
        const validated = validateBook(book);
        if (!validated.ok) return validated;
        return ok(book);
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
