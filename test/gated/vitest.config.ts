// Config for the gated suite: the root vitest.config.ts excludes test/gated, so `vitest run test/gated` finds nothing.
// Run: PI_BG_GATED=1 npx vitest run --config test/gated/vitest.config.ts --no-file-parallelism
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/gated/**/*.test.ts"], testTimeout: 60_000, fileParallelism: false, root: new URL("../..", import.meta.url).pathname },
});
