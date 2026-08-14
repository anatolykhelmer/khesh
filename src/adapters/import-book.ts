import { jsonToBook } from "./json-codec";
import type { Result } from "../kernel/result";
import type { Book } from "../kernel/types";
import type { LedgerRepository } from "../ports/ledger-repository";

export async function importJson(repo: LedgerRepository, raw: string): Promise<Result<Book>> {
  const parsed = jsonToBook(raw);
  if (!parsed.ok) return parsed;
  const saved = await repo.save(parsed.value);
  if (!saved.ok) return saved;
  return parsed;
}
