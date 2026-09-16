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
  });

  it("makes no per-row balance query", () => {
    expect(source).not.toContain("balanceInRange(");
    expect(source).not.toContain("balanceOf(");
  });
});
