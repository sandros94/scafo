import baseConfig from "./vitest.config.ts";
import { defineConfig } from "vitest/config";

/* Suites using this config either need no services or own their containers. */
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    globalSetup: [],
  },
});
