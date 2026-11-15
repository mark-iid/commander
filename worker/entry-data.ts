// Reads and writes for the entry surface.
//
// Ported from the entry half of app/repository.py. D1 has no open transaction
// to hold across statements, so anything that has to be all-or-nothing goes
// through db.batch(), which D1 applies atomically. Where that matters is called
// out at the site.

import { enteredKey } from "./entry-rules.ts";

export interface TurnValues {
  attacking_creatures: number;
  cmdr_dmg_dealt: number;
  noncombat_dmg_dealt: number;
  opps_eliminated: number;
}

export interface Turn extends TurnValues {
  round_no: number;
  /** Combat damage to each opponent. Absent means none. */
  damage: Map<string, number>;
}

export interface FinalValues {
  placement: number | null;
  final_life: number;
  total_graveyard: number;
}

export async function findGame(
  db: D1Database,
  eventId: number,
  pod: string,
  matchNo: number,
): Promise<number | null> {
  const row = await db
    .prepare("SELECT game_id FROM games WHERE event_id = ? AND pod = ? AND match_no = ?")
    .bind(eventId, pod, matchNo)
    .first<{ game_id: number }>();
  return row?.game_id ?? null;
}

export async function getOrCreateGame(
  db: D1Database,
  eventId: number,
  pod: string,
  matchNo: number,
): Promise<number> {
  const existing = await findGame(db, eventId, pod, matchNo);
  if (existing !== null) return existing;
  try {
    const result = await db
      .prepare("INSERT INTO games (event_id, pod, match_no) VALUES (?, ?, ?)")
      .bind(eventId, pod, matchNo)
      .run();
    return Number(result.meta.last_row_id);
  } catch (e) {
    // The other tracker created it between the select and the insert. The
    // unique index on (event_id, pod, match_no) is what makes this safe, and
    // two trackers entering the same pod at once is the normal case, not an
    // edge one.
    const again = await findGame(db, eventId, pod, matchNo);
    if (again !== null) return again;
    throw e;
  }
}

/** Roster name to player_id for one event. */
export async function playerIds(
  db: D1Database,
  eventId: number,
): Promise<Map<string, number>> {
  const { results } = await db
    .prepare("SELECT player_id, name FROM players WHERE event_id = ?")
    .bind(eventId)
    .all<{ player_id: number; name: string }>();
  return new Map(results.map((r) => [r.name, r.player_id]));
}

/**
 * Set who is at this table, in turn order. Replaces any prior seating.
 *
 * Seats are 1..n in the order given, which is the order play passes around the
 * table; the entry screen walks it to decide whose turn is next.
 *
 * Reseating a table that already has turns recorded is allowed and deletes
 * nothing: the turns stay attached to their players, and every total counts
 * only players seated here now. So a player moved off takes no score with them
 * and leaves none behind, and seating them back restores it. An empty list
 * clears the table, which is how a swap between pods is made once every player
 * is dealt.
 *
 * One batch, so a table is never left half-seated for the other tracker.
 */
export async function seatPlayers(
  db: D1Database,
  gameId: number,
  playerIdsInOrder: number[],
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM game_seats WHERE game_id = ?").bind(gameId),
    ...playerIdsInOrder.map((pid, i) =>
      db
        .prepare("INSERT INTO game_seats (game_id, player_id, seat) VALUES (?, ?, ?)")
        .bind(gameId, pid, i + 1),
    ),
  ]);
}

/**
 * Highest turn cycle recorded at this table, 0 if play has not started.
 *
 * The table shares one round counter rather than each player keeping their
 * own: a turn cycle is a lap of the table, and letting the counters drift apart
 * would make "round 4" mean different points of the game for different players.
 */
export async function roundsPlayed(db: D1Database, gameId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(MAX(t.round_no), 0) AS n FROM turn_stats t
       JOIN game_seats s ON s.game_id = t.game_id AND s.player_id = t.player_id
       WHERE t.game_id = ?`,
    )
    .bind(gameId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Every recorded turn at a table, keyed by enteredKey(player, round).
 *
 * One query for the whole table: the entry screen shows a grid of who has
 * entered what, and doing it per cell was N+1 round trips against a database
 * two trackers are already writing to.
 */
export async function turnGrid(db: D1Database, gameId: number): Promise<Map<string, Turn>> {
  const [turnRows, dmgRows] = await db.batch([
    db
      .prepare(
        `SELECT p.name AS player, t.round_no, t.attacking_creatures, t.cmdr_dmg_dealt,
                t.noncombat_dmg_dealt, t.opps_eliminated
         FROM turn_stats t
         JOIN players p ON p.player_id = t.player_id
         WHERE t.game_id = ?`,
      )
      .bind(gameId),
    db
      .prepare(
        `SELECT p.name AS player, d.round_no, tgt.name AS target, d.combat_dmg
         FROM turn_damage d
         JOIN game_seats sd ON sd.game_id = d.game_id AND sd.player_id = d.player_id
         JOIN game_seats st ON st.game_id = d.game_id AND st.player_id = d.target_id
         JOIN players p ON p.player_id = d.player_id
         JOIN players tgt ON tgt.player_id = d.target_id
         WHERE d.game_id = ?`,
      )
      .bind(gameId),
  ]);

  const damage = new Map<string, Map<string, number>>();
  for (const r of dmgRows!.results as {
    player: string;
    round_no: number;
    target: string;
    combat_dmg: number;
  }[]) {
    const key = enteredKey(r.player, r.round_no);
    const targets = damage.get(key) ?? new Map<string, number>();
    targets.set(r.target, r.combat_dmg);
    damage.set(key, targets);
  }

  const grid = new Map<string, Turn>();
  for (const r of turnRows!.results as ({ player: string } & Turn)[]) {
    const key = enteredKey(r.player, r.round_no);
    grid.set(key, {
      round_no: r.round_no,
      attacking_creatures: r.attacking_creatures,
      cmdr_dmg_dealt: r.cmdr_dmg_dealt,
      noncombat_dmg_dealt: r.noncombat_dmg_dealt,
      opps_eliminated: r.opps_eliminated,
      damage: damage.get(key) ?? new Map(),
    });
  }
  return grid;
}

/**
 * Upsert one player's one turn cycle, damage grid included.
 *
 * The damage rows are deleted and rewritten rather than upserted one by one: a
 * correction that drops an opponent's damage to zero has to remove the row, and
 * an upsert alone would leave the old value behind.
 *
 * The delete only touches players seated here now. The form shows no box for
 * anyone else, so a hit on somebody reseated away was not resubmitted, and
 * deleting it would make the reseat destructive.
 *
 * One batch: a turn whose stats landed but whose damage did not would read as
 * a real turn in which nobody attacked.
 */
export async function saveTurn(
  db: D1Database,
  gameId: number,
  playerId: number,
  turn: Turn,
  idsByName: Map<string, number>,
): Promise<void> {
  const targets: [number, number][] = [];
  for (const [name, dmg] of turn.damage) {
    // An explicit zero would be harmless for the sums, but it is a row per
    // opponent per turn of nothing, and MAX() over the taken aggregate reads
    // the same either way.
    if (dmg === 0) continue;
    const targetId = idsByName.get(name);
    if (targetId === undefined) throw new Error(`no such player: ${name}`);
    if (targetId === playerId) {
      throw new Error(`${name} cannot deal combat damage to themselves`);
    }
    targets.push([targetId, dmg]);
  }

  await db.batch([
    db
      .prepare(
        `INSERT INTO turn_stats (
           game_id, player_id, round_no,
           attacking_creatures, cmdr_dmg_dealt, noncombat_dmg_dealt, opps_eliminated
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(game_id, player_id, round_no) DO UPDATE SET
           attacking_creatures = excluded.attacking_creatures,
           cmdr_dmg_dealt = excluded.cmdr_dmg_dealt,
           noncombat_dmg_dealt = excluded.noncombat_dmg_dealt,
           opps_eliminated = excluded.opps_eliminated`,
      )
      .bind(
        gameId,
        playerId,
        turn.round_no,
        turn.attacking_creatures,
        turn.cmdr_dmg_dealt,
        turn.noncombat_dmg_dealt,
        turn.opps_eliminated,
      ),
    db
      .prepare(
        `DELETE FROM turn_damage
         WHERE game_id = ? AND player_id = ? AND round_no = ?
           AND target_id IN (SELECT player_id FROM game_seats WHERE game_id = ?)`,
      )
      .bind(gameId, playerId, turn.round_no, gameId),
    ...targets.map(([targetId, dmg]) =>
      db
        .prepare(
          `INSERT INTO turn_damage (game_id, player_id, round_no, target_id, combat_dmg)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(gameId, playerId, turn.round_no, targetId, dmg),
    ),
  ]);
}

export async function turnFor(
  db: D1Database,
  gameId: number,
  player: string,
  roundNo: number,
): Promise<Turn | null> {
  const grid = await turnGrid(db, gameId);
  return grid.get(enteredKey(player, roundNo)) ?? null;
}

export async function finalFor(
  db: D1Database,
  gameId: number,
  player: string,
): Promise<FinalValues | null> {
  const row = await db
    .prepare(
      `SELECT f.placement, f.final_life, f.total_graveyard
       FROM game_player_stats f
       JOIN players p ON p.player_id = f.player_id
       WHERE f.game_id = ? AND p.name = ?`,
    )
    .bind(gameId, player)
    .first<{ placement: number | null; final_life: number | null; total_graveyard: number }>();
  if (!row) return null;
  return {
    placement: row.placement,
    final_life: row.final_life ?? 0,
    total_graveyard: row.total_graveyard,
  };
}

/**
 * Upsert the death/win section for several players at once.
 *
 * One attack can put two players out together, and their placements are one
 * fact split across two rows: the finishing order. Written row by row, a
 * failure on the second would leave the first holding a placement the order it
 * came from never produced, so the whole group goes in one batch.
 *
 * Only the named players are touched. Everybody else at the table is mid-game
 * and has no placement yet, which is what scoring reads as "still playing".
 */
export async function saveFinals(
  db: D1Database,
  gameId: number,
  byPlayerId: Map<number, FinalValues>,
): Promise<void> {
  if (byPlayerId.size === 0) return;
  await db.batch(
    [...byPlayerId].map(([playerId, final]) =>
      db
        .prepare(
          `INSERT INTO game_player_stats
             (game_id, player_id, placement, final_life, total_graveyard)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(game_id, player_id) DO UPDATE SET
             placement = excluded.placement,
             final_life = excluded.final_life,
             total_graveyard = excluded.total_graveyard`,
        )
        .bind(gameId, playerId, final.placement, final.final_life, final.total_graveyard),
    ),
  );
}

/** {player name: deck} for one match. Players with none are absent. */
export async function commandersForMatch(
  db: D1Database,
  eventId: number,
  matchNo: number,
): Promise<Map<string, string>> {
  const { results } = await db
    .prepare(
      `SELECT p.name AS name, c.commander
       FROM match_commanders c
       JOIN players p ON p.player_id = c.player_id
       WHERE c.event_id = ? AND c.match_no = ?`,
    )
    .bind(eventId, matchNo)
    .all<{ name: string; commander: string }>();
  return new Map(results.map((r) => [r.name, r.commander]));
}

/**
 * Record which deck each named player brought to this match.
 *
 * A blank box deletes the row rather than storing an empty string, so "no deck
 * recorded" is one state and not two. commander is NOT NULL for that reason.
 */
export async function saveMatchCommanders(
  db: D1Database,
  eventId: number,
  matchNo: number,
  byPlayerId: Map<number, string>,
): Promise<void> {
  if (byPlayerId.size === 0) return;
  await db.batch(
    [...byPlayerId].map(([playerId, deck]) =>
      deck.trim() === ""
        ? db
            .prepare(
              "DELETE FROM match_commanders WHERE event_id = ? AND player_id = ? AND match_no = ?",
            )
            .bind(eventId, playerId, matchNo)
        : db
            .prepare(
              `INSERT INTO match_commanders (event_id, player_id, match_no, commander)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(event_id, player_id, match_no) DO UPDATE SET
                 commander = excluded.commander`,
            )
            .bind(eventId, playerId, matchNo, deck.trim()),
    ),
  );
}

/**
 * Players already seated at another pod for the same match.
 *
 * Seating rotates every match, so the seating form has to stop the same player
 * being dealt into pod A and pod B of match 2, which would give them two rows
 * for one match and quietly inflate their win points.
 *
 * `excludeGame` is null for a table nobody has opened yet, which is the second
 * pod of every match: everyone seated anywhere is then elsewhere. A bare
 * `game_id <> NULL` would match no rows at all.
 */
export async function seatedElsewhere(
  db: D1Database,
  eventId: number,
  matchNo: number,
  excludeGame: number | null,
): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT p.name FROM game_seats s
       JOIN players p ON p.player_id = s.player_id
       JOIN games g ON g.game_id = s.game_id
       WHERE g.event_id = ? AND g.match_no = ? AND (?3 IS NULL OR g.game_id <> ?3)`,
    )
    .bind(eventId, matchNo, excludeGame)
    .all<{ name: string }>();
  return new Set(results.map((r) => r.name));
}

export interface PlayerRow {
  player_id: number;
  name: string;
  commander: string | null;
  prize_eligible: number;
  roster_position: number;
}

export async function players(db: D1Database, eventId: number): Promise<PlayerRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM players WHERE event_id = ? ORDER BY roster_position")
    .bind(eventId)
    .all<PlayerRow>();
  return results;
}
