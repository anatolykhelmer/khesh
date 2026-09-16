import { configDefaults, defineConfig } from "vitest/config";
import { DeepCoverVitestReporter } from "@anatolykhelmer/deep-cover/reporter/vitest";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    exclude: [...configDefaults.exclude, "**/.claude/worktrees/**"],
    reporters: ["default", new DeepCoverVitestReporter()],
    coverage: { reporter: ["json"] },
  },
});
