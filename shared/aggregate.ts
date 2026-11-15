// Rebuilding the per-game scalars the scoring engine consumes from the turn
// tables. The storage granularity is per turn, the engine's is per game, and
// this query is the whole of the translation between them -- which is why
// the scoring engine is unaffected by the storage granularity.
//
//   totals  SUM over a player's turns (combat dealt and taken, commander,
//           non-combat, eliminations, creatures attacked with)
//   peaks   MAX over a player's turns (biggest attack dealt and taken, creatures)
//   final   joined straight from game_player_stats (placement, life, graveyard)
//
// shared/schema.test.ts holds the result of this query to a recorded event.
//
// "Biggest attack dealt" is a turn's combat damage summed across every
// opponent, because one declared attack in Commander can hit several players at
// once. "Biggest attack taken" is a single turn_damage row: each row is already
// one dealer hitting one target in one turn, which is exactly one attack.
//
// Driven from game_seats rather than game_player_stats, so a seated player who
// has not acted yet still appears, with zeros and a null placement, rather than
// vanishing from the standings.

import type { GamePlayerStat } from "./scoring.ts";

/**
 * Combat damage between two players both currently seated at that game.
 *
 * A reseat leaves turns where they were, so a hit recorded against somebody
 * since moved to the other pod would otherwise still score for the dealer and
 * still count as taken. Every read of turn_damage that feeds a total goes
 * through this.
 */
const SEATED_DAMAGE = `
    SELECT d.game_id, d.player_id, d.round_no, d.target_id, d.combat_dmg
    FROM turn_damage d
    JOIN game_seats sd ON sd.game_id = d.game_id AND sd.player_id = d.player_id
    JOIN game_seats st ON st.game_id = d.game_id AND st.player_id = d.target_id
`;

/**
 * One row per seated player per game, shaped exactly like GamePlayerStat.
 *
 * `played` says whether anything is recorded for them yet: a turn of their own,
 * a hit taken, or the death/win row. A hit counts because the player is in the
 * game whether or not their own turn has come round, and the hit is theirs for
 * "biggest attack taken". Scoring skips rows where it is false.
 *
 * Append a WHERE clause before use: DERIVED_STATS + " WHERE gm.event_id = ?".
 */
export const DERIVED_STATS = `
WITH seated_damage AS (${SEATED_DAMAGE}),
per_round AS (
    SELECT game_id, player_id, round_no, SUM(combat_dmg) AS round_combat
    FROM seated_damage GROUP BY game_id, player_id, round_no
),
dealt AS (
    SELECT game_id, player_id,
           SUM(round_combat) AS total_combat,
           MAX(round_combat) AS biggest_dealt
    FROM per_round GROUP BY game_id, player_id
),
taken AS (
    SELECT game_id, target_id AS player_id,
           SUM(combat_dmg) AS total_taken,
           MAX(combat_dmg) AS biggest_taken
    FROM seated_damage GROUP BY game_id, target_id
),
turns AS (
    SELECT game_id, player_id,
           SUM(cmdr_dmg_dealt)      AS cmdr,
           SUM(noncombat_dmg_dealt) AS noncombat,
           SUM(opps_eliminated)     AS elims,
           MAX(attacking_creatures) AS creatures,
           SUM(attacking_creatures) AS creatures_total
    FROM turn_stats GROUP BY game_id, player_id
)
SELECT
    seats.game_id                     AS game_id,
    p.name                            AS player,
    f.placement                       AS placement,
    COALESCE(f.final_life, 0)         AS final_life,
    COALESCE(d.total_combat, 0)       AS combat_dmg_dealt,
    COALESCE(t.noncombat, 0)          AS noncombat_dmg_dealt,
    COALESCE(t.cmdr, 0)               AS cmdr_dmg_dealt,
    COALESCE(t.elims, 0)              AS opps_eliminated,
    COALESCE(d.biggest_dealt, 0)      AS biggest_attack_dealt,
    COALESCE(k.biggest_taken, 0)      AS biggest_attack_taken,
    COALESCE(t.creatures, 0)          AS most_creatures_in_attack,
    COALESCE(f.total_graveyard, 0)    AS total_graveyard,
    COALESCE(k.total_taken, 0)        AS combat_dmg_taken,
    COALESCE(t.creatures_total, 0)    AS creatures_attacked_with,
    (t.player_id IS NOT NULL OR k.player_id IS NOT NULL OR f.player_id IS NOT NULL)
                                      AS played
FROM game_seats seats
JOIN players p ON p.player_id = seats.player_id
JOIN games gm ON gm.game_id = seats.game_id
LEFT JOIN game_player_stats f ON f.game_id = seats.game_id AND f.player_id = seats.player_id
LEFT JOIN dealt d ON d.game_id = seats.game_id AND d.player_id = seats.player_id
LEFT JOIN taken k ON k.game_id = seats.game_id AND k.player_id = seats.player_id
LEFT JOIN turns t ON t.game_id = seats.game_id AND t.player_id = seats.player_id
`;

/** Every stat row for one event, ordered for a stable comparison. */
export const ALL_STATS = `${DERIVED_STATS} WHERE gm.event_id = ? ORDER BY seats.game_id, p.name`;

/** One game's rows, in finishing order then seat order, for the pod table. */
export const STATS_FOR_GAME =
  `${DERIVED_STATS} WHERE seats.game_id = ?` +
  " ORDER BY f.placement IS NULL, f.placement, seats.seat";

/**
 * A row from the query above, as the scoring engine wants it.
 *
 * SQLite has no boolean type, so `played` comes back as 0 or 1 and has to be
 * narrowed before the engine's `if (!s.played)` is reading an integer.
 */
export function toGamePlayerStat(row: Record<string, unknown>): GamePlayerStat {
  return {
    game_id: row["game_id"] as number,
    player: row["player"] as string,
    placement: (row["placement"] as number | null) ?? null,
    final_life: row["final_life"] as number,
    combat_dmg_dealt: row["combat_dmg_dealt"] as number,
    noncombat_dmg_dealt: row["noncombat_dmg_dealt"] as number,
    cmdr_dmg_dealt: row["cmdr_dmg_dealt"] as number,
    opps_eliminated: row["opps_eliminated"] as number,
    biggest_attack_dealt: row["biggest_attack_dealt"] as number,
    biggest_attack_taken: row["biggest_attack_taken"] as number,
    most_creatures_in_attack: row["most_creatures_in_attack"] as number,
    total_graveyard: row["total_graveyard"] as number,
    combat_dmg_taken: row["combat_dmg_taken"] as number,
    creatures_attacked_with: row["creatures_attacked_with"] as number,
    played: Boolean(row["played"]),
  };
}
