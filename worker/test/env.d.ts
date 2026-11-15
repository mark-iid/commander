// The migrations binding the test runtime gets handed, which the real Worker
// has no notion of. vitest.workers.config.ts reads migrations/ in node and
// passes them through as a binding, because workerd has no filesystem.
import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
