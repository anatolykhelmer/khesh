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
      const refs = [...page.html.matchAll(/(?:src|href|content)="([^"]+\.(?:png|webp|svg|ico|jpe?g))"/g)]
        .map((match) => match[1])
        .map((ref) => (ref.startsWith(SITE) ? ref.slice(SITE.length) : ref))
        .filter((ref) => ref.startsWith("/"));
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(existingImageUrls.has(ref), `${page.file} references ${ref}`).toBe(true);
      }
    }
  });

  it("keeps the share card out of every user's precache", () => {
    const ignores = /globIgnores:\s*\[([\s\S]*?)\]/.exec(viteConfigSource);
    expect(ignores?.[1]).toContain("og.png");
  });
});
