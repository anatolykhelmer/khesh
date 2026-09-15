import { ogCardHtml } from "../../scripts/og-card.ts";

const INPUT = { fontDataUri: "data:font/woff2;base64,FONT", shotDataUri: "data:image/webp;base64,SHOT" };

describe("ogCardHtml", () => {
  it("embeds both assets rather than linking to them", () => {
    const html = ogCardHtml(INPUT);
    expect(html).toContain(INPUT.fontDataUri);
    expect(html).toContain(INPUT.shotDataUri);
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
  });

  it("is laid out at exactly the card's size", () => {
    const html = ogCardHtml(INPUT);
    expect(html).toContain("width: 1200px");
    expect(html).toContain("height: 630px");
  });

  it("carries the three claims", () => {
    const html = ogCardHtml(INPUT);
    expect(html).toContain("Double-entry");
    expect(html).toContain("No account, no server");
    expect(html).toContain("Your Drive, not ours");
  });
});
