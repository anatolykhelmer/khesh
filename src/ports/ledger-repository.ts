import type { Result } from "../kernel/result";
import type { Book } from "../kernel/types";

export interface LedgerRepository {
  load(): Promise<Result<Book | null>>;
  save(book: Book): Promise<Result<void>>;
}
