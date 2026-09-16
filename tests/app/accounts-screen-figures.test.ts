import { describe, expect, it } from "vitest";
// `?raw` rather than node:fs: the project's tsconfig ships no node types, and Vite
// resolves this relative to the test file — the idiom `about-page.test.ts` set.
import source from "../../src/app/screens/AccountsScreen.tsx?raw";

/** The screen cannot be rendered under `environment: "node"`. What a test can say is
 * that the figures come from the whole-tree query and that nobody has put a per-row
 * kernel call back — each of those was one full journal scan per visible account. */
describe("AccountsScreen figures", () => {
  it("resolves figures through balancesByAccount", () => {
    expect(source).toContain("balancesByAccount(");
    // Two calls is the architecture: a running map and a month map gated on
    // monthFigure. A per-row call (inside figureLabel or renderNodes) would push
    // this to 3+, which is exactly the O(rows x journal) regression this guards.
    expect(source.match(/balancesByAccount\(/g) ?? []).toHaveLength(2);
    expect(source).toContain('monthFigure && monthFigure.kind === "month"');
  });

  it("makes no per-row balance query", () => {
    expect(source).not.toContain("balanceInRange(");
    expect(source).not.toContain("balanceOf(");
  });
});
