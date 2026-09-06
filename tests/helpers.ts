import type { Result } from "../src/kernel/result";

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

export function unwrapErr<T>(result: Result<T>) {
  if (result.ok) {
    throw new Error("expected error");
  }
  return result.error;
}

export const NOW = "2026-09-02T10:00:00.000Z";
export const LATER = "2026-09-02T11:00:00.000Z";
