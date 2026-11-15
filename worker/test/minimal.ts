// A small event, built directly, for tests that are about one write path
// rather than about a whole night. The Fall 2026 fixture is the right data for
// anything end to end; it is too much context for "does a reseat delete turns".

export interface Minimal {
  eventId: number;
  ids: Map<string, number>;
  table: string[];
}

export const TABLE = ["Ann", "Ben", "Cat", "Dan"];

export async function minimalEvent(db: D1Database): Promise<Minimal> {
  await db
    .prepare(
      "INSERT INTO events (event_id, name, games_per_player, pod_size) VALUES (1, 'Test Night', 3, 4)",
    )
    .run();
  await db.batch([
    db.prepare("INSERT INTO pods (event_id, label, position) VALUES (1, 'A', 1)"),
    db.prepare("INSERT INTO pods (event_id, label, position) VALUES (1, 'B', 2)"),
    ...TABLE.map((name, i) =>
      db
        .prepare(
          "INSERT INTO players (player_id, event_id, name, prize_eligible, roster_position)" +
            " VALUES (?, 1, ?, 1, ?)",
        )
        .bind(i + 1, name, i + 1),
    ),
    ...[
      [1, 4],
      [2, 3],
      [3, 2],
      [4, 1],
    ].map(([place, points]) =>
      db
        .prepare("INSERT INTO placement_points (event_id, placement, points) VALUES (1, ?, ?)")
        .bind(place, points),
    ),
    db
      .prepare(
        "INSERT INTO total_damage_fields (event_id, field, position) VALUES (1, 'combat_dmg_dealt', 1)",
      ),
    db.prepare("INSERT INTO active_event (singleton, event_id) VALUES (1, 1)"),
  ]);
  return {
    eventId: 1,
    ids: new Map(TABLE.map((name, i) => [name, i + 1])),
    table: TABLE,
  };
}
