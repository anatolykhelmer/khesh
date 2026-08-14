import type { LedgerError, LedgerErrorCode } from "./errors";

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: LedgerError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(
  code: LedgerErrorCode,
  message: string,
  details?: Record<string, unknown>,
): Result<T> {
  return { ok: false, error: { code, message, details } };
}
