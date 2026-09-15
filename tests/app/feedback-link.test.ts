import { describe, expect, it } from "vitest";
// `?raw` rather than node:fs: the project's tsconfig deliberately ships no node types,
// and Vite resolves these relative to this file instead of the working directory.
import settingsSource from "../../src/app/screens/SettingsScreen.tsx?raw";
import en from "../../src/app/locales/en.json";
import he from "../../src/app/locales/he.json";

/** Spelled out rather than assembled from parts, so a failure names the exact string a
 * reviewer can paste into a browser. `/discussions` and not `/discussions/new/choose`:
 * the latter redirects a signed-out visitor to a login form. */
const DISCUSSIONS_URL = "https://github.com/anatolykhelmer/khesh/discussions";

function lookup(locale: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
      locale,
    );
}

/** Settings is the only screen a user with a book reaches from inside the app, and this
 * row is the app's one route to the author. Nothing else in the suite would notice its
 * loss: vitest runs in node with no jsdom, so no test renders this screen — which is why
 * the assertion is on the source text and why it can claim nothing about layout. */
describe("feedback link", () => {
  it("Settings links to the repository's Discussions page", () => {
    expect(settingsSource).toContain(`href="${DISCUSSIONS_URL}"`);
  });

  it("names the destination in both locales", () => {
    for (const [name, locale] of [
      ["en", en],
      ["he", he],
    ] as const) {
      const label = lookup(locale, "settings.feedbackLink");
      const hint = lookup(locale, "settings.feedbackHint");
      expect(typeof label, name).toBe("string");
      expect(String(label).trim().length, name).toBeGreaterThan(0);
      // A translation that drops "Discussions" leaves the reader a question and no place
      // to answer it; the Hebrew string keeps the product name in Latin for that reason.
      expect(String(hint), name).toContain("Discussions");
    }
  });
});
