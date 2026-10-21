import { defineConfig } from "vitest/config";

// The suites share one seeded database, so files must not run concurrently.
export default defineConfig({
  test: { fileParallelism: false, hookTimeout: 30000, testTimeout: 30000 },
});
