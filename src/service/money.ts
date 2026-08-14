/** Convert a major-unit decimal string to integer minor units (default 2 fraction digits). */
export function majorToMinor(major: string, fractionDigits = 2): number | null {
  const trimmed = major.trim();
  if (!trimmed) return null;
  const re = new RegExp(`^(0|[1-9]\\d*)(\\.\\d{1,${fractionDigits}})?$`);
  if (!re.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = frac.padEnd(fractionDigits, "0");
  if (fracPadded.length > fractionDigits) return null;
  const minor = Number(whole) * 10 ** fractionDigits + Number(fracPadded || 0);
  if (!Number.isInteger(minor) || minor < 0) return null;
  return minor;
}

export function minorToMajor(minor: number, fractionDigits = 2): string {
  if (!Number.isInteger(minor)) throw new Error("minor must be integer");
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 10 ** fractionDigits);
  const frac = String(abs % 10 ** fractionDigits).padStart(fractionDigits, "0");
  return `${sign}${whole}.${frac}`;
}
