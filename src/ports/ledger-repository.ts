import type { Result } from "../kernel/result";
import type { Book } from "../kernel/types";

export interface LedgerRepository {
  load(): Promise<Result<Book | null>>;
  save(book: Book): Promise<Result<void>>;
  /** Delete the stored book. A missing book is not a failure: a reset that runs twice,
   * or one that follows a failed write, must still report success. */
  clear(): Promise<Result<void>>;
}
