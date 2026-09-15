import { describe, expect, it } from "vitest";
// `?raw` rather than node:fs: the project's tsconfig deliberately ships no node types,
// and Vite resolves these relative to this file instead of the working directory.
import indexHtml from "../../index.html?raw";
import aboutHtml from "../../public/about.html?raw";
import privacyHtml from "../../public/privacy.html?raw";
import sitemapXml from "../../public/sitemap.xml?raw";
import robotsTxt from "../../public/robots.txt?raw";
import viteConfigSource from "../../vite.config.ts?raw";

const SITE = "https://www.khesh.app";

const PAGES = [
  { file: "index.html", canonical: `${SITE}/`, html: indexHtml },
  { file: "public/about.html", canonical: `${SITE}/about.html`, html: aboutHtml },
  { file: "public/privacy.html", canonical: `${SITE}/privacy.html`, html: privacyHtml },
] as const;

// Two independent sources for what pages exist, so this test still fails if the sitemap
// and the actual files on disk drift apart - a hard-coded list on either side would not
// catch that. `import.meta.glob` enumerates the real files; it is never invoked, only its
// keys are read, so no loader is needed for the files it matches.
const publicHtmlFiles = import.meta.glob("../../public/*.html");
const publicImageFiles = import.meta.glob("../../public/**/*.{png,webp,svg,ico,jpg,jpeg}");

/** A glob key like "../../public/shots/dashboard-light.webp" back to the root-relative
 * URL the HTML actually references it by, e.g. "/shots/dashboard-light.webp". */
const toRootUrl = (globKey: string) => globKey.replace(/^.*\/public\//, "/");

const existingImageUrls = new Set(Object.keys(publicImageFiles).map(toRootUrl));

/** Every image URL a page's markup points at — from attribute refs (src/href/content) and
 * srcset candidates — normalized to a root-relative path. Shared by the "exists" check
 * below and the "still referenced" one, so both see the same notion of a reference. */
function refsIn(html: string): string[] {
  const attrRefs = [
    ...html.matchAll(/(?:src|href|content)="([^"]+\.(?:png|webp|svg|ico|jpe?g))"/g),
  ].map((match) => match[1]);

  // srcset is a comma-separated list of "<url> <descriptor>?" candidates (e.g.
  // "a.webp 1x, b.webp 2x"). Every use on these pages is a single candidate today,
  // but parsing it as the list the spec allows means a future 2x candidate stays
  // covered instead of silently dropping out of this check.
  const srcsetRefs = [...html.matchAll(/srcset="([^"]+)"/g)].flatMap((match) =>
    match[1]
      .split(",")
      .map((candidate) => candidate.trim().split(/\s+/)[0])
      .filter((url) => /\.(?:png|webp|svg|ico|jpe?g)$/.test(url)),
  );

  return [...attrRefs, ...srcsetRefs]
    .map((ref) => (ref.startsWith(SITE) ? ref.slice(SITE.length) : ref))
    .filter((ref) => ref.startsWith("/"));
}

describe("static pages", () => {
  for (const page of PAGES) {
    describe(page.file, () => {
      it("states its own address", () => {
        expect(page.html).toContain(`<link rel="canonical" href="${page.canonical}" />`);
      });

      it("has a description a search result can show", () => {
        const match = /<meta\s+name="description"\s+content="([^"]+)"/.exec(page.html);
        expect(match?.[1].length ?? 0).toBeGreaterThan(50);
      });

      it("has a title that says what this is", () => {
        const match = /<title>([^<]+)<\/title>/.exec(page.html);
        expect(match?.[1].length ?? 0).toBeGreaterThan(10);
      });
    });
  }

  it("lists exactly the site's pages in the sitemap", () => {
    const locs = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    const pages = Object.keys(publicHtmlFiles).map((path) => `${SITE}${toRootUrl(path)}`);
    expect(new Set(locs)).toEqual(new Set([`${SITE}/`, ...pages]));
  });

  it("points crawlers at the sitemap", () => {
    expect(robotsTxt).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });

  it("tells a search engine that about.html describes a free application", () => {
    const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(aboutHtml);
    const data = JSON.parse(match![1]);
    expect(data["@type"]).toBe("SoftwareApplication");
    expect(data.offers.price).toBe("0");
  });

  // Only the two pages this task actually modifies (per the Files list; privacy.html
  // isn't touched here and has no share-card copy to assert on).
  const SHARE_CARD_PAGES = PAGES.filter(
    (page) => page.file === "index.html" || page.file === "public/about.html",
  );

  it("covers exactly the two pages with a share card", () => {
    // Non-vacuity: if the predicate above ever stopped matching, the `it()` blocks below
    // would vanish silently instead of failing. Mirrors the guard at
    // tests/app/spa-fallback.test.ts:58.
    expect(SHARE_CARD_PAGES).toHaveLength(2);
  });

  for (const page of SHARE_CARD_PAGES) {
    it(`${page.file} carries a share card`, () => {
      const html = page.html;
      expect(html).toContain(`<meta property="og:image" content="${SITE}/og.png" />`);
      expect(html).toContain('<meta property="og:image:width" content="1200" />');
      expect(html).toContain('<meta property="og:image:height" content="630" />');
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
      expect(html).toMatch(/<meta property="og:title" content="[^"]{10,}" \/>/);
      expect(html).toMatch(/<meta property="og:description" content="[^"]{50,}" \/>/);
    });
  }

  it("references only image files that exist", () => {
    for (const page of PAGES) {
      const refs = refsIn(page.html);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(existingImageUrls.has(ref), `${page.file} references ${ref}`).toBe(true);
      }
    }
  });

  // The check above catches a screenshot file being renamed or deleted, but not the markup
  // referencing it being cut — e.g. removing the whole `.shots` block from about.html would
  // still leave the favicon and og:image refs behind, so `refs.length > 0` and every
  // remaining ref would still resolve, and this would ship with no screenshots on the page.
  it("still shows every screenshot it has", () => {
    const shots = [...existingImageUrls].filter((url) => url.startsWith("/shots/"));
    expect(shots).toHaveLength(6);
    const aboutRefs = refsIn(aboutHtml);
    for (const shot of shots) expect(aboutRefs).toContain(shot);
  });

  // Both this test and the next read vite.config.ts as source, so each asserts its regex
  // matched before asserting anything about what it captured. Without that, the negative
  // assertion below is the dangerous one: a regex that stopped matching hands it `undefined`,
  // and `expect(undefined).not.toContain("webp")` passes — a guard that quietly stops
  // guarding, which is the failure these two exist to prevent.
  it("keeps the share card out of every user's precache", () => {
    const ignores = /globIgnores:\s*\[([\s\S]*?)\]/.exec(viteConfigSource);
    expect(ignores).not.toBeNull();
    expect(ignores?.[1]).toContain("og.png");
  });

  // vite.config.ts leaves webp out of globPatterns deliberately (see the comment there): the
  // six landing-page screenshots would otherwise land in every installed PWA's precache.
  // Nothing else pins that decision down — it's easy to "fix" a missing offline screenshot
  // by adding webp back to the pattern and never notice this suite stayed green.
  it("keeps webp out of every user's precache", () => {
    const patterns = /globPatterns:\s*\[([\s\S]*?)\]/.exec(viteConfigSource);
    expect(patterns).not.toBeNull();
    expect(patterns?.[1]).not.toContain("webp");
  });

  // BL-060: about.html and privacy.html render from their own inline <style> with zero
  // JavaScript, so neither can ever run the app's update prompt — a precached copy would
  // go stale forever with no way for a visitor to notice. See vite.config.ts for the
  // matching navigateFallbackDenylist entry this relies on (asserted in spa-fallback.test.ts):
  // dropping these from the precache without it would hand every navigation to them the
  // app shell instead.
  it("keeps about.html and privacy.html out of every user's precache", () => {
    const ignores = /globIgnores:\s*\[([\s\S]*?)\]/.exec(viteConfigSource);
    expect(ignores).not.toBeNull();
    expect(ignores?.[1]).toContain("about.html");
    expect(ignores?.[1]).toContain("privacy.html");
  });
});
