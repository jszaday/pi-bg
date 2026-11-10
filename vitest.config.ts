import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/gated/**", "node_modules/**"],
    testTimeout: 10_000,
  },
});
