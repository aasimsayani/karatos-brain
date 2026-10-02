import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each Postgres test boots an embedded database, which takes a few seconds.
    testTimeout: 30_000,
  },
  resolve: {
    // Test workspace packages from source so no build step is needed first.
    alias: {
      "@karatos/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
    },
  },
});
