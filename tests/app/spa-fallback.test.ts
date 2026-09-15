import { describe, expect, it } from "vitest";
// `?raw` rather than node:fs: the project's tsconfig deliberately ships no node types,
// and Vite resolves these relative to this file instead of the working directory.
import appSource from "../../src/app/App.tsx?raw";
import vercelJson from "../../vercel.json?raw";
import viteConfigSource from "../../vite.config.ts?raw";

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

/** Every route the app declares, hoisted so every test below that needs it reuses the
 * same extraction instead of re-running it — but each such test still asserts
 * non-vacuity itself before looping, so any one of them fails on its own (not just the
 * first) if the extraction ever breaks. See the "covers every route the app declares"
 * test for the canonical shape this guard follows. */
const appRoutePaths = routePaths(appSource);

describe("SPA fallback rewrite", () => {
  it("sends unmatched paths to the app shell", () => {
    expect(rewrite.destination).toBe("/index.html");
    expect(config.rewrites).toHaveLength(1);
  });

  it("covers every route the app declares", () => {
    // Non-vacuity: a broken extraction would otherwise assert nothing at all.
    expect(appRoutePaths.length).toBeGreaterThan(10);
    for (const path of appRoutePaths) {
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

/** BL-060: the service worker's NavigationRoute has no allowlist of its own, so once
 * about.html and privacy.html are excluded from the precache (vite.config.ts globIgnores),
 * something has to stop that route from handing every navigation to them the cached app
 * shell instead. navigateFallbackDenylist does that by denying any path whose last segment
 * contains a dot — deliberately the same invariant the Vercel rewrite above rests on, so
 * these two suites stay in lockstep instead of drifting apart. */

// Unlike globIgnores/globPatterns above (plain quoted strings), this array holds a regex
// literal whose character classes (`[^/?]`) contain their own "]" and "/" — a lazy match
// to the first "]" would stop inside the literal instead of at the array's real close. Stay
// on one line and take the last "]" on it, which the literal itself never abuts with a comma.
const denylistMatch = /navigateFallbackDenylist:\s*\[(.*)\],?\s*$/m.exec(viteConfigSource);
const denylistSource = denylistMatch?.[1]?.trim() ?? "";
// The captured text is a JavaScript RegExp literal (e.g. `/…/`), so it's evaluable as one.
// Guarded by the non-vacuity test below: if the source regex above stops matching,
// `denylistSource` is "" and this stays `undefined` instead of throwing here at import
// time, so the failure shows up as a normal assertion failure inside `it()`.
// eslint-disable-next-line no-eval
const denyPattern: RegExp | undefined = denylistSource ? eval(denylistSource) : undefined;

describe("navigateFallbackDenylist", () => {
  it("is declared in vite.config.ts", () => {
    // Non-vacuity: a regex that stopped matching would hand every assertion below
    // `undefined`, and `expect(undefined?.test(...)).toBe(false)` passes — a guard that
    // quietly stops guarding, which is the failure this test exists to prevent.
    expect(denylistMatch).not.toBeNull();
    expect(denylistSource.length).toBeGreaterThan(0);
  });

  it("denies navigation to the two static pages", () => {
    expect(denyPattern?.test("/about.html")).toBe(true);
    expect(denyPattern?.test("/privacy.html")).toBe(true);
    // A tracking query string is normal for a landing page and must not defeat the guard —
    // the regex is tested against pathname + search, never pathname alone.
    expect(denyPattern?.test("/about.html?utm_source=newsletter")).toBe(true);
  });

  it("leaves every real app route for the precached shell to handle", () => {
    expect(denyPattern?.test("/")).toBe(false);
    // Non-vacuity: a broken extraction would otherwise assert nothing at all.
    expect(appRoutePaths.length).toBeGreaterThan(10);
    for (const path of appRoutePaths) {
      expect(denyPattern?.test(path), `route ${path} was wrongly denied`).toBe(false);
    }
  });
});

/** BL-060 (review follow-up): SettingsScreen.tsx and SetupStep.tsx link to about.html and
 * privacy.html from inside the installed, offline-first app shell. navigateFallbackDenylist
 * above stops the app shell from answering for those two paths, but by itself that would
 * leave an offline visitor with nothing — this runtimeCaching entry is what actually serves
 * them, network-first with a cache fallback, so the in-app links keep working offline. */

type RuntimeCachingEntry = {
  urlPattern: (arg: { url: URL }) => boolean;
  handler: string;
  options?: { cacheName?: string; networkTimeoutSeconds?: number };
};

// Same concern as navigateFallbackDenylist above: this array holds an object (not a plain
// string), and the object's own braces don't help a lazy `[...]` match, but — unlike that
// regex literal — nothing inside this block contains a literal "]", so the first one really
// is the array's close. Anchored on the field that follows it in vite.config.ts (workbox's
// closing brace) so a reordering wouldn't silently start matching too much either.
const runtimeCachingMatch = /runtimeCaching:\s*\[([\s\S]*?)\]\s*,?\s*\n\s*\},/.exec(
  viteConfigSource,
);
const runtimeCachingSource = runtimeCachingMatch?.[1]?.trim() ?? "";
// eslint-disable-next-line no-eval
const runtimeCaching: RuntimeCachingEntry[] = runtimeCachingSource
  ? (eval(`[${runtimeCachingSource}]`) as RuntimeCachingEntry[])
  : [];

describe("runtimeCaching (offline fallback for the two static pages)", () => {
  it("is declared in vite.config.ts", () => {
    // Non-vacuity, same reasoning as above: a regex that stopped matching would hand every
    // assertion below an empty array, and `for (const e of [])` runs zero times and passes.
    expect(runtimeCachingMatch).not.toBeNull();
    expect(runtimeCachingSource.length).toBeGreaterThan(0);
    expect(runtimeCaching.length).toBeGreaterThan(0);
  });

  it("matches exactly the two static pages, not real app routes", () => {
    // Non-vacuity: a broken extraction would otherwise assert nothing at all.
    expect(appRoutePaths.length).toBeGreaterThan(10);
    for (const entry of runtimeCaching) {
      expect(entry.urlPattern({ url: new URL("https://khesh.app/about.html") })).toBe(true);
      expect(entry.urlPattern({ url: new URL("https://khesh.app/privacy.html") })).toBe(true);
      expect(entry.urlPattern({ url: new URL("https://khesh.app/") })).toBe(false);
      for (const path of appRoutePaths) {
        expect(
          entry.urlPattern({ url: new URL(path, "https://khesh.app") }),
          `route ${path} was wrongly claimed by runtimeCaching`,
        ).toBe(false);
      }
    }
  });

  it("serves them network-first with a bounded timeout, not cache-first", () => {
    for (const entry of runtimeCaching) {
      expect(entry.handler).toBe("NetworkFirst");
      expect(entry.options?.cacheName).toBeTruthy();
      // Unbounded would hang on a dead connection instead of falling back to the cache —
      // see the comment in vite.config.ts for why 3s specifically.
      expect(entry.options?.networkTimeoutSeconds).toBeGreaterThan(0);
    }
  });
});
