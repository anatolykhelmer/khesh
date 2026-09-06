import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The policy is a static document with no component test around it, and its URL is
 * pasted into Google's consent screen configuration. These assertions cover the parts
 * whose silent loss would be noticed by a Google reviewer before it is noticed here. */
describe("privacy policy page", () => {
  const html = readFileSync("public/privacy.html", "utf8");

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
});
