import { defineConfig } from "vitest/config";

export default defineConfig({
  // "@perfoads/source" points workspace packages at their TypeScript sources (see each package.json "exports").
  resolve: { conditions: ["@perfoads/source"] },
  ssr: { resolve: { conditions: ["@perfoads/source"] } },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    // Tracks SQLite handles and fails like Windows (EBUSY) when an open store is deleted.
    setupFiles: ["packages/store/src/testing/openStoreTracker.ts"],
  },
});
