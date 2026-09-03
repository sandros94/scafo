import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/_global-setup.ts"],
    /* Agent worktrees carry a full copy of the repo; never collect their suites. */
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**", "**/.agents/**"],
    coverage: {
      exclude: [
        "dist/**",
        "docs/**",
        "test/**",
        "playgrounds/**",
        "build.config.ts",
        "vitest.config.ts",
      ],
    },
  },
});
