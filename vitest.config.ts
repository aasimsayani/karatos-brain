import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    // Each Postgres test boots an embedded database, which takes a few seconds.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      // Process entry point: exercised by the Docker smoke test, not unit tests.
      exclude: ["packages/server/src/main.ts", "packages/*/src/index.ts"],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
  resolve: {
    // Test workspace packages from source so no build step is needed first.
    alias: {
      "@karatos/core": src("./packages/core/src/index.ts"),
      "@karatos/store-postgres": src("./packages/store-postgres/src/index.ts"),
      "@karatos/retail": src("./packages/retail/src/index.ts"),
    },
  },
});
