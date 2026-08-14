import { describe, expect, it } from "vitest";
import { resolveInitialLanguage } from "../../src/app/i18n";

describe("resolveInitialLanguage", () => {
  it("uses the stored language when it is a supported value", () => {
    expect(resolveInitialLanguage("he", "en-US")).toBe("he");
    expect(resolveInitialLanguage("en", "he-IL")).toBe("en");
  });

  it("falls back to the browser language when nothing is stored", () => {
    expect(resolveInitialLanguage(null, "he-IL")).toBe("he");
    expect(resolveInitialLanguage(null, "he")).toBe("he");
  });

  it("defaults to English when the browser language is not Hebrew", () => {
    expect(resolveInitialLanguage(null, "en-US")).toBe("en");
    expect(resolveInitialLanguage(null, "fr-FR")).toBe("en");
    expect(resolveInitialLanguage(null, undefined)).toBe("en");
  });

  it("ignores a stored value that isn't a supported language", () => {
    expect(resolveInitialLanguage("fr", "he-IL")).toBe("he");
    expect(resolveInitialLanguage("corrupted", undefined)).toBe("en");
  });
});
