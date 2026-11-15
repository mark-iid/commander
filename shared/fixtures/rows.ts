// Turning a fixture into rows for the schema in migrations/0001_initial.sql.
//
// Runtime-free: no node imports and no D1, so both the node:sqlite tests and
// the Worker tests load the same mapping.
//
// The fixture's `raw` section is the event as recorded. What the mapping adds:
//   pods              rows, from the distinct pod labels the games used
//   roster_position   explicit, from the fixture's roster order
//   prize_eligible    a flag per player, from scoring.prize_ineligible
//   placement_points, total_damage_fields, prizes   rows, from the config
//   active_event      the pointer the unqualified surfaces resolve through

import type { Fixture } from "./fall-2026.ts";

export type Row = Record<string, number | string | null>;
export interface TableRows {
  table: string;
  rows: Row[];
}

/** Tables carried across unchanged, in foreign-key dependency order. */
const CARRIED = [
  "games",
  "game_seats",
  "turn_stats",
  "turn_damage",
  "game_player_stats",
  "match_commanders",
] as const;

/**
 * Every row the fixture becomes, in insertion order.
 *
 * Order is load-bearing: foreign keys are enforced in D1 and in the tests, so a
 * child row before its parent fails the constraint rather than the assertion.
 */
export function seedRows(fixture: Fixture): TableRows[] {
  const raw = fixture.raw;
  const event = raw["events"]![0]!;
  const event_id = event["event_id"] as number;

  // pod_size was optional in the YAML and defaulted to the number of placement
  // tiers, on the reasoning that 1..4 is already the statement that a pod seats
  // four. It is an explicit column now, so the default is applied once here.
  const pod_size = Object.keys(fixture.scoring.placement_points).length;

  const labels = [...new Set(raw["games"]!.map((g) => g["pod"] as string | null))]
    .filter((l): l is string => l !== null)
    .sort();

  const ineligible = new Set(
    typeof fixture.scoring.prize_ineligible === "string"
      ? [fixture.scoring.prize_ineligible]
      : (fixture.scoring.prize_ineligible ?? []),
  );

  return [
    {
      table: "events",
      rows: [
        {
          event_id,
          name: event["name"]!,
          date: event["date"] ?? null,
          games_per_player: event["games_per_player"]!,
          pod_size,
          notes: event["notes"] ?? null,
        },
      ],
    },
    {
      table: "pods",
      rows: labels.map((label, i) => ({ event_id, label, position: i + 1 })),
    },
    {
      table: "players",
      rows: raw["players"]!.map((p) => ({
        player_id: p["player_id"]!,
        event_id,
        name: p["name"]!,
        commander: p["commander"] ?? null,
        prize_eligible: ineligible.has(p["name"] as string) ? 0 : 1,
        // Roster order was the players table's insertion order, which the old
        // repository read back as ORDER BY player_id. Made explicit here.
        roster_position: fixture.roster.indexOf(p["name"] as string) + 1,
      })),
    },
    {
      table: "placement_points",
      rows: Object.entries(fixture.scoring.placement_points as Record<string, number>).map(
        ([placement, points]) => ({ event_id, placement: Number(placement), points }),
      ),
    },
    {
      table: "total_damage_fields",
      rows: fixture.scoring.total_damage_fields.map((field, i) => ({
        event_id,
        field,
        position: i + 1,
      })),
    },
    {
      table: "prizes",
      rows: fixture.prizes.map((p, i) => ({
        event_id,
        key: p.key,
        name: p.name,
        metric: p.metric,
        agg: p.agg,
        scope: p.scope,
        tiebreak_field: p.tiebreak?.field ?? null,
        tiebreak_direction: p.tiebreak?.direction ?? null,
        tiebreak_scope: p.tiebreak?.scope ?? "night",
        position: i + 1,
      })),
    },
    ...CARRIED.map((table) => ({ table, rows: raw[table]! })),
    { table: "active_event", rows: [{ singleton: 1, event_id }] },
  ];
}

/** `INSERT INTO t (a, b) VALUES (?, ?)` plus the values, in column order. */
export function insertStatement(table: string, row: Row): { sql: string; values: Row[string][] } {
  const cols = Object.keys(row).sort();
  return {
    sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    values: cols.map((c) => row[c]!),
  };
}

export function eventIdOf(fixture: Fixture): number {
  return fixture.raw["events"]![0]!["event_id"] as number;
}
