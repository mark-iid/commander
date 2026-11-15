import { applyD1Migrations, env } from "cloudflare:test";

// Each test file gets the schema applied to its own isolated D1. Migrations are
// idempotent through wrangler's own bookkeeping table, so this is the same path
// `wrangler d1 migrations apply` takes.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
