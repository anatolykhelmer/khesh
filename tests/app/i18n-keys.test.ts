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

describe("locale key parity", () => {
  it("en and he define exactly the same base keys", () => {
    expect(baseKeys(he)).toEqual(baseKeys(en));
  });

  it("every plural family carries the universal _other form", () => {
    for (const locale of [en, he]) {
      const keys = new Set(keyPaths(locale));
      for (const family of pluralFamilies(locale)) {
        expect(keys).toContain(`${family}_other`);
      }
    }
  });
});
