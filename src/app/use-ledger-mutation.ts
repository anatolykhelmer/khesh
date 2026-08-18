import { useState } from "react";
import type { Book } from "../kernel";
import type { Result } from "../kernel/result";
import { errorMessage } from "../service/error-messages";
import { useLedger } from "./ledger-context";

/**
 * The shape every screen write shares: hold a busy flag across the await, turn a
 * failed Result into a banner message, and on success clear the banner and adopt the
 * returned book. `onSuccess` runs after the new book is in context and receives it,
 * which is what a caller needs to navigate to something the mutation just created.
 */
export function useLedgerMutation() {
  const { setBook, setError } = useLedger();
  const [busy, setBusy] = useState(false);

  async function run(
    action: () => Promise<Result<Book>>,
    onSuccess?: (book: Book) => void,
  ): Promise<void> {
    setBusy(true);
    const result = await action();
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result.error.code));
      return;
    }
    setError(null);
    setBook(result.value);
    onSuccess?.(result.value);
  }

  return { busy, run };
}
