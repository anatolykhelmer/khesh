import { describe, expect, it } from "vitest";
// `?raw` rather than node:fs: the project's tsconfig deliberately ships no node types,
// and Vite resolves these relative to this file instead of the working directory.
import appSource from "../../src/app/App.tsx?raw";
import vercelJson from "../../vercel.json?raw";

/** The hosting rewrite that makes a direct GET for a React Router path work (BL-032).
 *
 * These assertions compile the pattern as a JavaScript regular expression, while Vercel
 * compiles it with path-to-regexp. They pin what the pattern is meant to do, not what the
 * platform does with it — the deployed URL matrix in the spec is what covers that. What
 * they genuinely protect is the invariant the pattern rests on: that no route path in
 * `App.tsx` contains a dot. That file keeps changing; this test is why a future route
 * carrying one fails here rather than in production. */

const config = JSON.parse(vercelJson) as {
  rewrites: { source: string; destination: string }[];
};

const rewrite = config.rewrites[0];
const pattern = new RegExp(`^${rewrite.source}$`);

/** Stand-ins for the `:param` segments React Router owns. Ids are ULIDs (Crockford
 * base32) and the recurrence date is an ISO calendar day — neither can contain a dot,
 * which is the property the pattern depends on. */
const PARAM_SAMPLES: Record<string, string> = {
  accountId: "01K4S9YQZ7VN3T6WBHDXM2G8FR",
  entryId: "01K4S9YQZ7VN3T6WBHDXM2G8FR",
  ruleId: "01K4S9YQZ7VN3T6WBHDXM2G8FR",
  date: "2026-09-07",
};

/** Every `<Route path="…">` in `App.tsx`, with parameters filled in and the catch-all
 * dropped — `*` is React Router's own syntax and never reaches the network. */
function routePaths(source: string): string[] {
  return [...source.matchAll(/<Route\s+path="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((path) => path !== "*")
    .map((path) =>
      path.replace(/:([A-Za-z]+)/g, (_whole, name: string) => {
        const sample = PARAM_SAMPLES[name];
        if (sample === undefined) {
          throw new Error(`No sample value for route parameter :${name}`);
        }
        return sample;
      }),
    );
}

describe("SPA fallback rewrite", () => {
  it("sends unmatched paths to the app shell", () => {
    expect(rewrite.destination).toBe("/index.html");
    expect(config.rewrites).toHaveLength(1);
  });

  it("covers every route the app declares", () => {
    const paths = routePaths(appSource);
    // Non-vacuity: a broken extraction would otherwise assert nothing at all.
    expect(paths.length).toBeGreaterThan(10);
    for (const path of paths) {
      expect(pattern.test(path), `route ${path} is not covered by the rewrite`).toBe(true);
    }
  });

  it("covers the root", () => {
    expect(pattern.test("/")).toBe(true);
  });

  it("leaves the static pages Google's consent screen points at alone", () => {
    expect(pattern.test("/privacy.html")).toBe(false);
    expect(pattern.test("/about.html")).toBe(false);
  });

  it("leaves build output and PWA files alone", () => {
    expect(pattern.test("/index.html")).toBe(false);
    expect(pattern.test("/assets/index-abc123.js")).toBe(false);
    expect(pattern.test("/assets/index-abc123.css")).toBe(false);
    expect(pattern.test("/assets/heebo-hebrew-wght-normal-BPH8bhzJ.woff2")).toBe(false);
    expect(pattern.test("/icon-192.png")).toBe(false);
    expect(pattern.test("/favicon.svg")).toBe(false);
    expect(pattern.test("/sw.js")).toBe(false);
    expect(pattern.test("/manifest.webmanifest")).toBe(false);
  });
});
