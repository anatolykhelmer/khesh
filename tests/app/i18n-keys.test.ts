import { describe, expect, it } from "vitest";
import en from "../../src/app/locales/en.json";
import he from "../../src/app/locales/he.json";

function keyPaths(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null) return [prefix];
  return Object.entries(obj).flatMap(([key, value]) =>
    keyPaths(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe("locale key parity", () => {
  it("en and he define exactly the same keys", () => {
    const enKeys = keyPaths(en).sort();
    const heKeys = keyPaths(he).sort();
    expect(heKeys).toEqual(enKeys);
  });
});
