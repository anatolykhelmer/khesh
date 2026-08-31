import { describe, expect, it } from "vitest";
import en from "../../src/app/locales/en.json";
import he from "../../src/app/locales/he.json";

function keyPaths(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null) return [prefix];
  return Object.entries(obj).flatMap(([key, value]) =>
    keyPaths(value, prefix ? `${prefix}.${key}` : key),
  );
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** CLDR plural categories differ per language (Hebrew has a dual; English does not),
 * so locales legitimately disagree on suffixed keys. Parity holds on base keys. */
function baseKeys(obj: unknown): string[] {
  return [...new Set(keyPaths(obj).map((key) => key.replace(PLURAL_SUFFIX, "")))].sort();
}

/** Base keys that appear with at least one plural suffix in the given locale. */
function pluralFamilies(obj: unknown): string[] {
  return [
    ...new Set(
      keyPaths(obj)
        .filter((key) => PLURAL_SUFFIX.test(key))
        .map((key) => key.replace(PLURAL_SUFFIX, "")),
    ),
  ].sort();
}

/** The precache ships only the latin, latin-ext, and hebrew Heebo subsets
 * (vite.config.ts globIgnores). A glyph outside them is fetched from the math or
 * symbols file, which is no longer precached — system-font fallback when offline. */
const ALLOWED_NON_ASCII = new Set([..."·×–—›…₪€"]);

function stringValues(obj: unknown): string[] {
  if (typeof obj === "string") return [obj];
  if (typeof obj !== "object" || obj === null) return [];
  return Object.values(obj).flatMap(stringValues);
}

describe("locale key parity", () => {
  it("en and he define exactly the same base keys", () => {
    expect(baseKeys(he)).toEqual(baseKeys(en));
  });

  it("every plural family carries the universal _other form", () => {
    expect(pluralFamilies(he).length).toBeGreaterThan(0);
    for (const locale of [en, he]) {
      const keys = new Set(keyPaths(locale));
      for (const family of pluralFamilies(locale)) {
        expect(keys).toContain(`${family}_other`);
      }
    }
  });

  it("uses no glyph outside the precached font subsets", () => {
    for (const locale of [en, he]) {
      for (const value of stringValues(locale)) {
        for (const ch of value) {
          const cp = ch.codePointAt(0)!;
          if (cp < 0x80) continue;
          if (cp >= 0x0590 && cp <= 0x05ff) continue; // hebrew subset
          expect(ALLOWED_NON_ASCII).toContain(ch);
        }
      }
    }
  });
});
