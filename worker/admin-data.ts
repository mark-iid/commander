// Reads and writes for the admin surface.
//
// Events, roster CRUD, result counts, and the two reset levels.

import { ACTIVE_EVENT_ID, type EventRow } from "./data.ts";

/** A player is part of a game if any of this is true. */
const PLAYER_IN_A_GAME = `
       EXISTS (SELECT 1 FROM game_seats        WHERE player_id = ?1)
    OR EXISTS (SELECT 1 FROM turn_stats        WHERE player_id = ?1)
    OR EXISTS (SELECT 1 FROM turn_damage       WHERE player_id = ?1 OR target_id = ?1)
    OR EXISTS (SELECT 1 FROM game_player_stats WHERE player_id = ?1)
`;

export class DuplicatePlayerName extends Error {}

function isDuplicate(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed: players/.test(e.message);
}

/**
 * Add a player to the end of the roster.
 *
 * roster_position is MAX + 1 rather than a count: a deletion leaves a gap, and
 * reusing a number would collide with the unique index. Roster order is the
 * scoring engine's last-resort tiebreaker, so where a new player lands is a
 * real decision, and the end is the only one that cannot reorder anybody else.
 */
export async function addPlayer(
  db: D1Database,
  eventId: number,
  name: string,
  commander: string | null,
  prizeEligible = true,
): Promise<number> {
  try {
    const result = await db
      .prepare(
        `INSERT INTO players (event_id, name, commander, prize_eligible, roster_position)
         VALUES (?1, ?2, ?3, ?4,
           (SELECT COALESCE(MAX(roster_position), 0) + 1 FROM players WHERE event_id = ?1))`,
      )
      .bind(eventId, name, commander, prizeEligible ? 1 : 0)
      .run();
    return Number(result.meta.last_row_id);
  } catch (e) {
    if (isDuplicate(e)) throw new DuplicatePlayerName(name);
    throw e;
  }
}

export async function updatePlayer(
  db: D1Database,
  eventId: number,
  playerId: number,
  name: string,
  commander: string | null,
  prizeEligible: boolean,
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE players SET name = ?, commander = ?, prize_eligible = ?
         WHERE event_id = ? AND player_id = ?`,
      )
      .bind(name, commander, prizeEligible ? 1 : 0, eventId, playerId)
      .run();
  } catch (e) {
    if (isDuplicate(e)) throw new DuplicatePlayerName(name);
    throw e;
  }
}

/**
 * Refuses, in one statement, to delete a player who is part of a game: seated
 * at a table, with a turn, hit by someone else's turn, or with a death/win row.
 * Each of those cascades away with the player, and a hit taken is another
 * player's combat damage.
 *
 * The guard has to live in the same statement as the delete. A separate
 * check-then-delete is a time-of-check/time-of-use race: a tracker saving that
 * player's first stat row in the window between the two would have their game
 * silently cascaded away.
 *
 * Returns true if a row was deleted.
 */
export async function deletePlayer(
  db: D1Database,
  eventId: number,
  playerId: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM players
       WHERE player_id = ?1 AND event_id = ?2
         AND NOT (${PLAYER_IN_A_GAME})`,
    )
    .bind(playerId, eventId)
    .run();
  return result.meta.changes === 1;
}

/**
 * True if deletePlayer would refuse on account of the player's games.
 *
 * A pre-check only, so the operator gets the specific reason. The refusal
 * itself is the statement above, which cannot be trusted to still hold by the
 * time it runs. A seat with nothing recorded counts: deleting it would leave
 * the table a player short.
 */
export async function playerHasStats(db: D1Database, playerId: number): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS yes WHERE ${PLAYER_IN_A_GAME}`).bind(playerId).first();
  return row !== null;
}

export async function getPlayer(
  db: D1Database,
  eventId: number,
  playerId: number,
): Promise<{ player_id: number; name: string; commander: string | null; prize_eligible: number } | null> {
  // Scoped by event: a hand-crafted form must not reach another event's players.
  return await db
    .prepare(
      `SELECT player_id, name, commander, prize_eligible
       FROM players WHERE event_id = ? AND player_id = ?`,
    )
    .bind(eventId, playerId)
    .first();
}

/**
 * (games, turn_rows) recorded for the event. What a reset would destroy.
 *
 * Counts turns, not death/win rows: turns are where the night's work is, and
 * quoting "4 rows" at an operator who entered ninety turn cycles would badly
 * understate what they are about to lose.
 */
export async function countResults(
  db: D1Database,
  eventId: number,
): Promise<{ games: number; stat_rows: number }> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM games WHERE event_id = ?1) AS games,
         (SELECT COUNT(*) FROM turn_stats
            WHERE game_id IN (SELECT game_id FROM games WHERE event_id = ?1)) AS stat_rows`,
    )
    .bind(eventId)
    .first<{ games: number; stat_rows: number }>();
  return row ?? { games: 0, stat_rows: 0 };
}

/**
 * Delete every game and stat row for the event; roster untouched.
 *
 * Returns what was destroyed. The deletes are written out rather than left to
 * ON DELETE CASCADE so the count is real: a cascade reports nothing, and
 * "deleted 0 rows" is the one answer an operator must be able to trust after
 * asking to wipe their data. Seating goes too, because a table set for a match
 * that no longer has results is not a result, it is a stale arrangement that
 * would silently reappear on the entry screen.
 *
 * One batch: a half-applied reset would leave games with no stats, which reads
 * on the display as a played round where everybody scored zero.
 */
export async function clearResults(
  db: D1Database,
  eventId: number,
): Promise<{ games: number; stat_rows: number }> {
  const before = await countResults(db, eventId);
  const scope = "game_id IN (SELECT game_id FROM games WHERE event_id = ?)";
  await db.batch([
    db.prepare(`DELETE FROM turn_damage WHERE ${scope}`).bind(eventId),
    db.prepare(`DELETE FROM turn_stats WHERE ${scope}`).bind(eventId),
    db.prepare(`DELETE FROM game_player_stats WHERE ${scope}`).bind(eventId),
    db.prepare(`DELETE FROM game_seats WHERE ${scope}`).bind(eventId),
    db.prepare("DELETE FROM games WHERE event_id = ?").bind(eventId),
    // The decks of a match are a result too: they describe games that no
    // longer exist.
    db.prepare("DELETE FROM match_commanders WHERE event_id = ?").bind(eventId),
  ]);
  return before;
}

/**
 * Delete every player in the event. Returns the number removed.
 *
 * Unguarded, unlike deletePlayer: this exists precisely to throw away a test
 * roster, and stats cascade away with it. Call clearResults first if you want
 * the count of what you destroyed.
 */
export async function clearRoster(db: D1Database, eventId: number): Promise<number> {
  const result = await db.prepare("DELETE FROM players WHERE event_id = ?").bind(eventId).run();
  return result.meta.changes ?? 0;
}

/**
 * A point the database can be restored to, captured before anything is deleted.
 *
 * There is no database file to copy and D1 keeps its own history, so the
 * equivalent of a pre-delete backup is to record where in that history the
 * operator was standing and hand it back:
 *
 *   wrangler d1 time-travel restore commander-tracker --bookmark=<it>
 *
 * Weaker than the old guarantee in one way, in that restoring is a command
 * somebody has to run rather than a file already written. Stronger in another,
 * in that it cannot fail to be taken, which is the failure the old code had to
 * handle by refusing to delete anything.
 *
 * Null if the runtime does not offer one, in which case the timestamp is the
 * fallback: Time Travel restores by either.
 */
export async function restorePoint(db: D1Database): Promise<string | null> {
  try {
    const session = db.withSession("first-primary");
    // A bookmark exists only once the session has run something.
    await session.prepare("SELECT 1").all();
    return session.getBookmark();
  } catch {
    return null;
  }
}

// --- events ------------------------------------------------------------------

export interface EventSummary extends EventRow {
  games: number;
  players: number;
  active: boolean;
}

/** Every event, newest first, with what is recorded in it and which is active. */
export async function eventSummaries(db: D1Database): Promise<EventSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT e.*,
         (SELECT COUNT(*) FROM games   g WHERE g.event_id = e.event_id) AS games,
         (SELECT COUNT(*) FROM players p WHERE p.event_id = e.event_id) AS players,
         e.event_id IS (${ACTIVE_EVENT_ID}) AS active
       FROM events e
       ORDER BY e.created_at DESC, e.event_id DESC`,
    )
    .all<EventRow & { games: number; players: number; active: number }>();
  return results.map((r) => ({ ...r, active: r.active === 1 }));
}

export interface NewEvent {
  name: string;
  date: string | null;
  /** The event whose pods, scoring and prizes are copied. */
  copyFrom: number;
  copyRoster: boolean;
  makeActive: boolean;
}

/**
 * Create an event from an existing one's configuration. Returns the new id, or
 * null if the source event does not exist.
 *
 * Copying is the only way to configure one: there is no prize editor, and an
 * event with no prizes, pods or placement points cannot be played. Results are
 * never copied. The roster is optional; copied players keep their commander,
 * eligibility and roster order, and are new rows, so nothing recorded in the
 * new event touches the old one.
 *
 * The id is chosen up front so every statement in the batch can name it. Two
 * admins creating at once collide on the primary key and the second batch
 * fails whole, which is the right outcome.
 */
export async function createEvent(db: D1Database, ev: NewEvent): Promise<number | null> {
  const source = await db
    .prepare("SELECT event_id FROM events WHERE event_id = ?")
    .bind(ev.copyFrom)
    .first<{ event_id: number }>();
  if (!source) return null;
  const next = await db
    .prepare("SELECT COALESCE(MAX(event_id), 0) + 1 AS id FROM events")
    .first<{ id: number }>();
  const id = next!.id;
  const from = ev.copyFrom;

  const statements = [
    db
      .prepare(
        `INSERT INTO events (event_id, name, date, games_per_player, pod_size)
         SELECT ?, ?, ?, games_per_player, pod_size FROM events WHERE event_id = ?`,
      )
      .bind(id, ev.name, ev.date, from),
    db
      .prepare("INSERT INTO pods (event_id, label, position) SELECT ?, label, position FROM pods WHERE event_id = ?")
      .bind(id, from),
    db
      .prepare(
        `INSERT INTO placement_points (event_id, placement, points)
         SELECT ?, placement, points FROM placement_points WHERE event_id = ?`,
      )
      .bind(id, from),
    db
      .prepare(
        `INSERT INTO total_damage_fields (event_id, field, position)
         SELECT ?, field, position FROM total_damage_fields WHERE event_id = ?`,
      )
      .bind(id, from),
    db
      .prepare(
        `INSERT INTO prizes (event_id, key, name, metric, agg, scope,
                             tiebreak_field, tiebreak_direction, tiebreak_scope, position)
         SELECT ?, key, name, metric, agg, scope,
                tiebreak_field, tiebreak_direction, tiebreak_scope, position
         FROM prizes WHERE event_id = ?`,
      )
      .bind(id, from),
  ];
  if (ev.copyRoster) {
    statements.push(
      db
        .prepare(
          `INSERT INTO players (event_id, name, commander, prize_eligible, roster_position)
           SELECT ?, name, commander, prize_eligible, roster_position FROM players WHERE event_id = ?`,
        )
        .bind(id, from),
    );
  }
  if (ev.makeActive) statements.push(activateStatement(db, id));
  await db.batch(statements);
  return id;
}

function activateStatement(db: D1Database, eventId: number): D1PreparedStatement {
  // The WHERE is what makes an unknown id change nothing. It is also required
  // by SQLite's grammar here: an upsert's SELECT needs one to be parsed.
  return db
    .prepare(
      `INSERT INTO active_event (singleton, event_id)
       SELECT 1, event_id FROM events WHERE event_id = ?
       ON CONFLICT (singleton) DO UPDATE SET event_id = excluded.event_id`,
    )
    .bind(eventId);
}

/** Point the unqualified surfaces at this event. False if there is no such event. */
export async function activateEvent(db: D1Database, eventId: number): Promise<boolean> {
  const result = await activateStatement(db, eventId).run();
  return (result.meta.changes ?? 0) > 0;
}

/** Rename an event or change its date. False if there is no such event. */
export async function updateEvent(
  db: D1Database,
  eventId: number,
  name: string,
  date: string | null,
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE events SET name = ?, date = ? WHERE event_id = ?")
    .bind(name, date, eventId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Delete an event and everything in it. False if nothing was deleted.
 *
 * Refuses the active event in the statement itself, not only in the route:
 * deleting it would leave the projector and every tracker on whatever event
 * the fallback picks next, mid-night. Everything else goes by cascade, so the
 * caller counts first if it wants to say what was destroyed.
 */
export async function deleteEvent(db: D1Database, eventId: number): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM events WHERE event_id = ? AND event_id IS NOT (${ACTIVE_EVENT_ID})`)
    .bind(eventId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
