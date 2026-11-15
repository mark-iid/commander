// Reads and writes for the admin surface.
//
// Roster CRUD, result counts, and the two reset levels.

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
