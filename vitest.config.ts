import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/_global-setup.ts"],
    coverage: {
      exclude: [
        "dist/**",
        "docs/**",
        "test/**",
        "playground/**",
        "build.config.ts",
        "vitest.config.ts",
      ],
    },
  },
});
