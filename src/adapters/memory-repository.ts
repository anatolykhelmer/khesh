import { ok, type Result } from "../kernel/result";
import type { Book } from "../kernel/types";
import type { LedgerRepository } from "../ports/ledger-repository";

export function createMemoryRepository(initial: Book | null = null): LedgerRepository {
  let current = initial;
  return {
    async load(): Promise<Result<Book | null>> {
      return ok(current);
    },
    async save(book: Book): Promise<Result<void>> {
      current = book;
      return ok(undefined);
    },
  };
}
