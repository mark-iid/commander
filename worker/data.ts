// Reading an event and its configuration out of D1.
//
// The configuration is rows rather than a file, so there is nothing to be out
// of date with the deployment and no renamed field that silently unclaims every
// prize.
//
// Everything here is a read. Writes live beside the route that performs them.

import { ALL_STATS, STATS_FOR_GAME, toGamePlayerStat } from "../shared/aggregate.ts";
import {
  type EventConfigInput,
  type GamePlayerStat,
  type ScoringConfig,
  scoringConfigFrom,
} from "../shared/scoring.ts";

export interface EventRow {
  event_id: number;
  name: string;
  date: string | null;
  games_per_player: number;
  pod_size: number;
  notes: string | null;
  archived_at: string | null;
}

/**
 * Which event the unqualified surfaces mean.
 *
 * The active_event pointer if it is set, and otherwise the newest event that is
 * not archived. The fallback is what makes a fresh database and a deleted event
 * both resolve to something sensible instead of 500-ing the projector.
 */
export async function activeEvent(db: D1Database): Promise<EventRow | null> {
  return await db
    .prepare(
      `SELECT e.* FROM events e
       LEFT JOIN active_event a ON a.event_id = e.event_id
       WHERE e.archived_at IS NULL OR a.event_id IS NOT NULL
       ORDER BY a.event_id IS NULL, e.created_at DESC, e.event_id DESC
       LIMIT 1`,
    )
    .first<EventRow>();
}

export async function getEvent(db: D1Database, eventId: number): Promise<EventRow | null> {
  return await db.prepare("SELECT * FROM events WHERE event_id = ?").bind(eventId).first<EventRow>();
}

export async function listEvents(db: D1Database): Promise<EventRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM events ORDER BY archived_at IS NOT NULL, created_at DESC, event_id DESC")
    .all<EventRow>();
  return results;
}

/** Roster names in roster order, which is the scoring engine's last tiebreaker. */
export async function roster(db: D1Database, eventId: number): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT name FROM players WHERE event_id = ? ORDER BY roster_position")
    .bind(eventId)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

export async function pods(db: D1Database, eventId: number): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT label FROM pods WHERE event_id = ? ORDER BY position")
    .bind(eventId)
    .all<{ label: string }>();
  return results.map((r) => r.label);
}

interface PrizeRow {
  key: string;
  name: string;
  metric: string;
  agg: "max" | "min";
  scope: "night" | "peak";
  tiebreak_field: string | null;
  tiebreak_direction: "max" | "min" | null;
  tiebreak_scope: "night" | "peak";
}

/**
 * The scoring configuration, as shared/scoring.ts wants it.
 *
 * One batch rather than four awaited queries: D1 is a network hop per call, and
 * the projector asks for this on every push.
 */
export async function scoringConfig(db: D1Database, eventId: number): Promise<ScoringConfig> {
  const [points, fields, ineligible, prizes] = await db.batch([
    db
      .prepare("SELECT placement, points FROM placement_points WHERE event_id = ? ORDER BY placement")
      .bind(eventId),
    db
      .prepare("SELECT field FROM total_damage_fields WHERE event_id = ? ORDER BY position")
      .bind(eventId),
    db
      .prepare(
        "SELECT name FROM players WHERE event_id = ? AND prize_eligible = 0 ORDER BY roster_position",
      )
      .bind(eventId),
    db.prepare("SELECT * FROM prizes WHERE event_id = ? ORDER BY position").bind(eventId),
  ]);

  const input: EventConfigInput = {
    scoring: {
      placement_points: Object.fromEntries(
        (points!.results as { placement: number; points: number }[]).map((r) => [
          String(r.placement),
          r.points,
        ]),
      ),
      total_damage_fields: (fields!.results as { field: string }[]).map((r) => r.field),
      prize_ineligible: (ineligible!.results as { name: string }[]).map((r) => r.name),
    },
    prizes: (prizes!.results as PrizeRow[]).map((p) => ({
      key: p.key,
      name: p.name,
      metric: p.metric,
      agg: p.agg,
      scope: p.scope,
      // The migration's CHECK makes a field and a direction all-or-nothing, so
      // testing one is testing both.
      tiebreak: p.tiebreak_field
        ? { field: p.tiebreak_field, direction: p.tiebreak_direction!, scope: p.tiebreak_scope }
        : null,
    })),
  };
  return scoringConfigFrom(input);
}

export async function allStats(db: D1Database, eventId: number): Promise<GamePlayerStat[]> {
  const { results } = await db.prepare(ALL_STATS).bind(eventId).all();
  return results.map((r) => toGamePlayerStat(r as Record<string, unknown>));
}

export async function statsForGame(db: D1Database, gameId: number): Promise<GamePlayerStat[]> {
  const { results } = await db.prepare(STATS_FOR_GAME).bind(gameId).all();
  return results.map((r) => toGamePlayerStat(r as Record<string, unknown>));
}

/** How many of the event's games have anything recorded against them. */
export async function gamesRecorded(db: D1Database, eventId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT gm.game_id) AS n FROM games gm
       WHERE gm.event_id = ?
         AND (EXISTS (SELECT 1 FROM turn_stats t WHERE t.game_id = gm.game_id)
              OR EXISTS (SELECT 1 FROM game_player_stats f WHERE f.game_id = gm.game_id))`,
    )
    .bind(eventId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// --- what the results sheet and the exports read -----------------------------

export interface GameRow {
  game_id: number;
  pod: string;
  match_no: number;
}

/**
 * Every game of the event, in the order a results sheet reads.
 *
 * pod and match_no are nullable so an ad-hoc game can escape the unique index
 * on (event, pod, match). Nothing creates one yet, but dropping such a row
 * would make a stat row whose game vanished silently absent from the sheet, so
 * sentinels keep it visible and sort it ahead of match 1, where it reads as the
 * anomaly it is.
 */
export async function games(db: D1Database, eventId: number): Promise<GameRow[]> {
  const { results } = await db
    .prepare(
      "SELECT game_id, pod, match_no FROM games WHERE event_id = ? ORDER BY match_no, pod",
    )
    .bind(eventId)
    .all<{ game_id: number; pod: string | null; match_no: number | null }>();
  return results.map((r) => ({
    game_id: r.game_id,
    pod: r.pod ?? "?",
    match_no: r.match_no ?? 0,
  }));
}

/** Every table's players in turn order, keyed by game. Empty if not seated. */
export async function allSeating(
  db: D1Database,
  eventId: number,
): Promise<Map<number, string[]>> {
  // One query, not one per game: the sheet reads every table of the night.
  const { results } = await db
    .prepare(
      `SELECT s.game_id, p.name FROM game_seats s
       JOIN players p ON p.player_id = s.player_id
       JOIN games g ON g.game_id = s.game_id
       WHERE g.event_id = ?
       ORDER BY s.game_id, s.seat`,
    )
    .bind(eventId)
    .all<{ game_id: number; name: string }>();
  const out = new Map<number, string[]>();
  for (const r of results) {
    const seats = out.get(r.game_id) ?? [];
    seats.push(r.name);
    out.set(r.game_id, seats);
  }
  return out;
}

export async function seating(db: D1Database, gameId: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT p.name FROM game_seats s
       JOIN players p ON p.player_id = s.player_id
       WHERE s.game_id = ? ORDER BY s.seat`,
    )
    .bind(gameId)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

/**
 * Per game: who dealt how much combat damage to whom over the match.
 *
 * Summed in SQL rather than by walking the turns, because the sheet wants the
 * totals and not the turns they came from. Keyed game -> dealer -> target.
 */
export async function damageMatrix(
  db: D1Database,
  eventId: number,
): Promise<Map<number, Map<string, Map<string, number>>>> {
  const { results } = await db
    .prepare(
      `SELECT d.game_id, p.name AS dealer, tgt.name AS target, SUM(d.combat_dmg) AS dmg
       FROM turn_damage d
       JOIN game_seats sd ON sd.game_id = d.game_id AND sd.player_id = d.player_id
       JOIN game_seats st ON st.game_id = d.game_id AND st.player_id = d.target_id
       JOIN games g ON g.game_id = d.game_id
       JOIN players p ON p.player_id = d.player_id
       JOIN players tgt ON tgt.player_id = d.target_id
       WHERE g.event_id = ?
       GROUP BY d.game_id, d.player_id, d.target_id`,
    )
    .bind(eventId)
    .all<{ game_id: number; dealer: string; target: string; dmg: number }>();
  const out = new Map<number, Map<string, Map<string, number>>>();
  for (const r of results) {
    const byDealer = out.get(r.game_id) ?? new Map<string, Map<string, number>>();
    const byTarget = byDealer.get(r.dealer) ?? new Map<string, number>();
    byTarget.set(r.target, r.dmg);
    byDealer.set(r.dealer, byTarget);
    out.set(r.game_id, byDealer);
  }
  return out;
}

/**
 * Every deck of the night, keyed "player name\u0000match_no".
 *
 * One query rather than one per match: the results sheet and both CSVs
 * annotate per-game rows, and a lookup per row is the N+1 this avoids. The key
 * uses a NUL separator because a player's name can contain anything a roster
 * form accepts, including the digits and punctuation a readable separator
 * would use.
 */
export async function allMatchCommanders(
  db: D1Database,
  eventId: number,
): Promise<Map<string, string>> {
  const { results } = await db
    .prepare(
      `SELECT p.name AS name, c.match_no, c.commander
       FROM match_commanders c
       JOIN players p ON p.player_id = c.player_id
       WHERE c.event_id = ?`,
    )
    .bind(eventId)
    .all<{ name: string; match_no: number; commander: string }>();
  return new Map(results.map((r) => [deckKey(r.name, r.match_no), r.commander]));
}

export function deckKey(player: string, matchNo: number): string {
  return `${player}\u0000${matchNo}`;
}

export interface RecordedTurn {
  game_id: number;
  player: string;
  round_no: number;
  attacking_creatures: number;
  cmdr_dmg_dealt: number;
  noncombat_dmg_dealt: number;
  opps_eliminated: number;
  /** Combat damage to each opponent this turn. Absent means none. */
  damage: Map<string, number>;
}

/**
 * Every turn recorded in the event, for the turn-level export.
 *
 * Two queries and an in-memory join rather than one per turn: a three-match
 * night is several hundred turns, and the export is a single request that
 * should not become several hundred round trips.
 *
 * Only players seated at the game now, like the derived stats: a turn left
 * behind by a reseat would otherwise put one player in both pods of a match.
 */
export async function allTurns(db: D1Database, eventId: number): Promise<RecordedTurn[]> {
  const [turnRows, dmgRows] = await db.batch([
    db
      .prepare(
        `SELECT t.game_id, p.name AS player, t.round_no, t.attacking_creatures,
                t.cmdr_dmg_dealt, t.noncombat_dmg_dealt, t.opps_eliminated
         FROM turn_stats t
         JOIN game_seats s ON s.game_id = t.game_id AND s.player_id = t.player_id
         JOIN games g ON g.game_id = t.game_id
         JOIN players p ON p.player_id = t.player_id
         WHERE g.event_id = ?`,
      )
      .bind(eventId),
    db
      .prepare(
        `SELECT d.game_id, p.name AS player, d.round_no, tgt.name AS target, d.combat_dmg
         FROM turn_damage d
         JOIN game_seats sd ON sd.game_id = d.game_id AND sd.player_id = d.player_id
         JOIN game_seats st ON st.game_id = d.game_id AND st.player_id = d.target_id
         JOIN games g ON g.game_id = d.game_id
         JOIN players p ON p.player_id = d.player_id
         JOIN players tgt ON tgt.player_id = d.target_id
         WHERE g.event_id = ?`,
      )
      .bind(eventId),
  ]);

  const damage = new Map<string, Map<string, number>>();
  for (const r of dmgRows!.results as {
    game_id: number;
    player: string;
    round_no: number;
    target: string;
    combat_dmg: number;
  }[]) {
    const key = `${r.game_id}\u0000${r.player}\u0000${r.round_no}`;
    const targets = damage.get(key) ?? new Map<string, number>();
    targets.set(r.target, r.combat_dmg);
    damage.set(key, targets);
  }

  return (turnRows!.results as Omit<RecordedTurn, "damage">[]).map((r) => ({
    ...r,
    damage: damage.get(`${r.game_id}\u0000${r.player}\u0000${r.round_no}`) ?? new Map(),
  }));
}
