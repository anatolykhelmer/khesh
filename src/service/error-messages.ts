import type { LedgerErrorCode } from "../kernel/errors";
import i18n from "../app/i18n";

export function errorMessage(code: LedgerErrorCode | string): string {
  return i18n.t(`errors.${code}`, { defaultValue: i18n.t("errors.unknown") });
}
