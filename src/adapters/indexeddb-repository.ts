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
      let value: unknown;
      try {
        const db = await getDb();
        value = await db.get(STORE, KEY);
      } catch {
        return err("STORAGE_UNAVAILABLE", "Failed to read IndexedDB");
      }
      if (value === undefined) return ok(null);
      // Separate try: storage already read fine (the block above would have returned
      // otherwise), so a throw here means the stored value itself doesn't parse as a
      // book — normalizeBook is not total over arbitrary input (e.g. no `accounts`
      // array, or a stored `null`). That is a broken book, not broken storage, and the
      // recovery screen routes on exactly this distinction: STORAGE_UNAVAILABLE offers
      // only Retry, which would re-read this identical record and fail identically,
      // leaving no way out. BOOK_INVALID reaches the branch that actually has one
      // (import a backup, start over). validateBook's own `!ok` return is unaffected
      // either way — it never throws, so it keeps propagating its specific code.
      try {
        const book = normalizeBook(value as StoredBook);
        const validated = validateBook(book);
        if (!validated.ok) return validated;
        return ok(book);
      } catch {
        return err("BOOK_INVALID", "Stored book could not be normalized or validated");
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
    async clear(): Promise<Result<void>> {
      try {
        const db = await getDb();
        // One key, not deleteDB: deleting the database blocks while another tab holds
        // it open, which is exactly the case the BroadcastChannel wiring exists for.
        await db.delete(STORE, KEY);
        return ok(undefined);
      } catch {
        return err("STORAGE_WRITE_FAILED", "Failed to clear IndexedDB");
      }
    },
  };
}
