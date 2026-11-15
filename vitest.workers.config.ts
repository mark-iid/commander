import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The Worker's own tests, run inside workerd against a real D1 binding.
//
// Migrations are read here, in node, and handed to the test runtime as a
// binding, because workerd has no filesystem. worker/test/apply-migrations.ts
// applies them before each test file, so every test starts on a schema built
// by the same files production's is.
//
// Note that D1 storage is NOT rolled back between tests: this version of the
// plugin has no isolated-storage option (the options schema strips unknown
// keys, so asking for one fails silently). Tests therefore reset what they use
// themselves, through worker/test/reset.ts, which is more explicit anyway.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Set here rather than read from .dev.vars, which is gitignored:
            // the suite must not depend on a file a fresh clone does not have.
            TRACKER_PASSCODE: "test-passcode",
            SESSION_SECRET: "test-secret-not-used-anywhere-real",
          },
        },
      }),
    ],
    test: {
      name: "worker",
      include: ["worker/**/*.test.ts"],
      // One file at a time. Whether the runtime isolates D1 storage between
      // test FILES is not a documented guarantee of this version, and with a
      // shared database two files resetting and seeding concurrently would
      // fail rarely and unreproducibly. The suite takes about a second, so
      // there is nothing to weigh against removing the question.
      fileParallelism: false,
      setupFiles: ["./worker/test/apply-migrations.ts"],
    },
  };
});
