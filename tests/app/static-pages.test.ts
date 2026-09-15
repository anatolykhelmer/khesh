// @ts-expect-error - Node types not available in this project
import { readFileSync, readdirSync } from "node:fs";

const SITE = "https://www.khesh.app";

const PAGES = [
  { file: "index.html", canonical: `${SITE}/` },
  { file: "public/about.html", canonical: `${SITE}/about.html` },
  { file: "public/privacy.html", canonical: `${SITE}/privacy.html` },
] as const;

const read = (file: string) => readFileSync(file, "utf8");

describe("static pages", () => {
  for (const page of PAGES) {
    describe(page.file, () => {
      it("states its own address", () => {
        expect(read(page.file)).toContain(`<link rel="canonical" href="${page.canonical}" />`);
      });

      it("has a description a search result can show", () => {
        const match = /<meta\s+name="description"\s+content="([^"]+)"/.exec(read(page.file));
        expect(match?.[1].length ?? 0).toBeGreaterThan(50);
      });

      it("has a title that says what this is", () => {
        const match = /<title>([^<]+)<\/title>/.exec(read(page.file));
        expect(match?.[1].length ?? 0).toBeGreaterThan(10);
      });
    });
  }

  it("lists exactly the site's pages in the sitemap", () => {
    const locs = [...read("public/sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m: RegExpExecArray) => m[1]);
    const pages = readdirSync("public")
      .filter((name: string) => name.endsWith(".html"))
      .map((name: string) => `${SITE}/${name}`);
    expect(new Set(locs)).toEqual(new Set([`${SITE}/`, ...pages]));
  });

  it("points crawlers at the sitemap", () => {
    expect(read("public/robots.txt")).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });

  it("tells a search engine that about.html describes a free application", () => {
    const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(
      read("public/about.html"),
    );
    const data = JSON.parse(match![1]);
    expect(data["@type"]).toBe("SoftwareApplication");
    expect(data.offers.price).toBe("0");
  });
});
