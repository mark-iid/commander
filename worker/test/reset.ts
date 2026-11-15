// Emptying the database between tests.
//
// This version of @cloudflare/vitest-plugin does not roll storage back between
// tests, and its options schema strips unknown keys, so asking for isolation
// that does not exist fails silently rather than erroring. Tests reset what
// they use instead.
//
// Deletes are ordered children-first rather than leaning on ON DELETE CASCADE:
// the cascade would do it today, but a table added later without one would
// turn this helper into a silent partial reset, and a test starting on another
// test's rows is the kind of failure that gets blamed on the code under test.

const TABLES = [
  "active_event",
  "match_commanders",
  "game_player_stats",
  "turn_damage",
  "turn_stats",
  "game_seats",
  "games",
  "prizes",
  "total_damage_fields",
  "placement_points",
  "players",
  "pods",
  "events",
  "login_attempts",
] as const;

export async function resetDatabase(db: D1Database): Promise<void> {
  await db.batch(TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)));
}
