import { defineConfig } from "vitest/config";

// Two projects, because the two halves of the test suite need different
// runtimes and neither can host the other.
//
//   shared   pure logic and the schema, run in node. node:sqlite speaks D1's
//            dialect, so the migration and the aggregation can be tested
//            without workerd, which keeps them fast.
//   worker   the Worker itself, run inside workerd with a real D1 binding
//            built from migrations/. Nothing is faked, so a difference between
//            D1 and SQLite shows up here rather than in production.
export default defineConfig({
  test: { projects: ["vitest.node.config.ts", "vitest.workers.config.ts"] },
});
