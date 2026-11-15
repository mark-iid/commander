// The node:sqlite adapter for shared/fixtures/rows.ts, used by the schema tests
// that apply the migration to a throwaway database. The Worker tests load the
// same rows through D1 instead; see worker/test/seed.ts.

import type { DatabaseSync } from "node:sqlite";
import type { Fixture } from "./fall-2026.ts";
import { eventIdOf, insertStatement, seedRows } from "./rows.ts";

export function seed(db: DatabaseSync, fixture: Fixture): number {
  for (const { table, rows } of seedRows(fixture)) {
    for (const row of rows) {
      const { sql, values } = insertStatement(table, row);
      db.prepare(sql).run(...values);
    }
  }
  return eventIdOf(fixture);
}
