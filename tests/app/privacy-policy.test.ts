import { describe, expect, it } from "vitest";
// `?raw` rather than node:fs: the project's tsconfig deliberately ships no node types,
// and Vite resolves these relative to this file instead of the working directory.
import html from "../../public/privacy.html?raw";
import settingsSource from "../../src/app/screens/SettingsScreen.tsx?raw";

/** The policy is a static document with no component test around it, and its URL is
 * pasted into Google's consent screen configuration. These assertions cover the parts
 * whose silent loss would be noticed by a Google reviewer before it is noticed here. */
describe("privacy policy page", () => {
  it("carries the Google Limited Use disclosure", () => {
    expect(html).toContain("Google API Services User Data Policy");
    expect(html).toContain("Limited Use requirements");
  });

  it("names the only scope the app requests", () => {
    expect(html).toContain("drive.file");
  });

  it("gives a contact channel", () => {
    expect(html).toContain("https://github.com/anatolykhelmer/khesh/issues");
  });

  it("is linked from the Settings screen at the path the file lives at", () => {
    expect(settingsSource).toContain('href="/privacy.html"');
  });
});
