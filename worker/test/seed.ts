// The D1 adapter for shared/fixtures/rows.ts: the real Fall 2026 night, loaded
// into the test runtime's database so route tests run against real data rather
// than a handful of invented rows.

import { eventIdOf, insertStatement, seedRows } from "../../shared/fixtures/rows.ts";
import { fixture } from "../../shared/fixtures/fall-2026.ts";

export async function seedFixture(db: D1Database): Promise<number> {
  // One batch per table rather than one for everything: D1 applies a batch in
  // order, but keeping the tables separate makes a foreign-key failure name the
  // table it happened in.
  for (const { table, rows } of seedRows(fixture)) {
    if (rows.length === 0) continue;
    await db.batch(
      rows.map((row) => {
        const { sql, values } = insertStatement(table, row);
        return db.prepare(sql).bind(...values);
      }),
    );
  }
  return eventIdOf(fixture);
}

export { fixture };
