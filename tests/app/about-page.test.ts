import { describe, expect, it } from "vitest";
// `?raw` rather than node:fs: the project's tsconfig deliberately ships no node types,
// and Vite resolves these relative to this file instead of the working directory.
import html from "../../public/about.html?raw";

/** The page Google's reviewer opens from the consent screen's "Application home page"
 * field. The rejection this page answers was "Your homepage does not explain the purpose
 * of your app", so these assertions cover the parts whose silent loss would be noticed
 * there before it was noticed here. */
describe("about page", () => {
  it("says what the app is and what it does", () => {
    expect(html).toContain("runs in your browser");
    expect(html).toContain("double-entry bookkeeping");
  });

  it("names the only scope the app requests", () => {
    expect(html).toContain("drive.file");
  });

  it("links to the privacy policy", () => {
    expect(html).toContain('href="/privacy.html"');
  });
});
