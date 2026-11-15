// The gate on phase 1: the new schema plus the relocated aggregation must
// reproduce the real night exactly.
//
// migrations/0001_initial.sql is applied to a throwaway SQLite database (D1 is
// SQLite, and node:sqlite speaks the same dialect, so this needs no Cloudflare
// account and no network), the Fall 2026 fixture is loaded into it, and the
// aggregation query is run over the result. Every derived row, every standing
// and all eleven prize winners must match the recorded result.
//
// That is the whole claim phase 1 has to make: the schema changed, the data
// moved, and not one result moved with it.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";
import { ALL_STATS, STATS_FOR_GAME, toGamePlayerStat } from "./aggregate.ts";
import { fixture } from "./fixtures/fall-2026.ts";
import { seed } from "./fixtures/seed.ts";
import {
  type GamePlayerStat,
  buildStandings,
  leaderboard,
  rankedStandings,
  scoringConfigFrom,
} from "./scoring.ts";

const MIGRATIONS = ["migrations/0001_initial.sql"];

function migrated(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // Off by default in SQLite, so a test without it would pass over broken
  // references. D1 enforces them, so the test has to as well.
  db.exec("PRAGMA foreign_keys = ON");
  for (const m of MIGRATIONS) db.exec(readFileSync(m, "utf8"));
  return db;
}

let db: DatabaseSync;
let event_id: number;
let derived: GamePlayerStat[];

beforeAll(() => {
  db = migrated();
  event_id = seed(db, fixture);
  derived = db.prepare(ALL_STATS).all(event_id).map((r) => toGamePlayerStat(r as Record<string, unknown>));
});

describe("the migration carries the night across unchanged", () => {
  test("the aggregation derives the same per-game rows", () => {
    // Sorted the same way the fixture is, by (game_id, player).
    expect(derived).toEqual(fixture.derived);
  });

  test("the standings and prize winners are identical", () => {
    const config = scoringConfigFrom(fixture);
    const standings = buildStandings(derived, config, fixture.roster);
    expect(standings).toEqual(fixture.expected.standings);
    expect(rankedStandings(standings).map(([rank, st]) => [rank, st.player])).toEqual(
      fixture.expected.ranked,
    );
    expect(leaderboard(derived, config, fixture.roster)).toEqual(fixture.expected.prizes);
  });

  test("the config now in the database reproduces the config it replaced", () => {
    // The YAML's roster order and prize_ineligible list became a column and a
    // flag. Both have to read back as the same inputs the engine was given, or
    // the tiebreakers quietly change.
    const roster = db
      .prepare("SELECT name FROM players WHERE event_id = ? ORDER BY roster_position")
      .all(event_id)
      .map((r) => (r as { name: string }).name);
    expect(roster).toEqual(fixture.roster);

    const ineligible = db
      .prepare("SELECT name FROM players WHERE event_id = ? AND prize_eligible = 0 ORDER BY roster_position")
      .all(event_id)
      .map((r) => (r as { name: string }).name);
    expect(ineligible).toEqual(fixture.scoring.prize_ineligible);

    const points = db
      .prepare("SELECT placement, points FROM placement_points WHERE event_id = ? ORDER BY placement")
      .all(event_id);
    expect(points).toEqual([
      { placement: 1, points: 4 },
      { placement: 2, points: 3 },
      { placement: 3, points: 2 },
      { placement: 4, points: 1 },
    ]);

    const fields = db
      .prepare("SELECT field FROM total_damage_fields WHERE event_id = ? ORDER BY position")
      .all(event_id)
      .map((r) => (r as { field: string }).field);
    expect(fields).toEqual(fixture.scoring.total_damage_fields);

    const prizes = db
      .prepare("SELECT key FROM prizes WHERE event_id = ? ORDER BY position")
      .all(event_id)
      .map((r) => (r as { key: string }).key);
    expect(prizes).toEqual(fixture.prizes.map((p) => p.key));
  });

  test("a single game's rows come back in finishing order", () => {
    // What the pod table renders: whoever is out, in the order they went out,
    // then the players still alive in seat order.
    const game_id = fixture.raw["games"]![0]!["game_id"] as number;
    const rows = db.prepare(STATS_FOR_GAME).all(game_id).map((r) => toGamePlayerStat(r as Record<string, unknown>));
    expect(rows.length).toBe(4);
    expect(rows.map((r) => r.placement)).toEqual([1, 2, 3, 4]);
  });

  test("the pointer resolves to the event that was played", () => {
    const row = db.prepare("SELECT event_id FROM active_event WHERE singleton = 1").get();
    expect((row as { event_id: number }).event_id).toBe(event_id);
  });
});

describe("damage follows the seating, not the history", () => {
  // The seated-damage join in aggregate.ts is a no-op for the Fall 2026 data,
  // because nobody was reseated that night. So the tests above would all pass
  // with the join deleted -- verified by mutation -- and this is what holds it.

  function reseatAway(db: DatabaseSync, game_id: number, player_id: number): number {
    // Swap the player out of the table for somebody who was not at it, the way
    // seat_players rewrites a table's seat rows on any reseat. Their turns and
    // their damage stay recorded against the game.
    const replacement = fixture.raw["players"]!.find(
      (p) =>
        !fixture.raw["game_seats"]!.some(
          (sx) => sx["game_id"] === game_id && sx["player_id"] === p["player_id"],
        ),
    )!["player_id"] as number;
    const seat = db
      .prepare("SELECT seat FROM game_seats WHERE game_id = ? AND player_id = ?")
      .get(game_id, player_id) as { seat: number };
    db.prepare("DELETE FROM game_seats WHERE game_id = ? AND player_id = ?").run(game_id, player_id);
    db.prepare("INSERT INTO game_seats (game_id, player_id, seat) VALUES (?, ?, ?)").run(
      game_id,
      replacement,
      seat.seat,
    );
    return replacement;
  }

  test("a reseated player's damage stops counting for both sides of it", () => {
    const fresh = migrated();
    const event = seed(fresh, fixture);
    const read = () =>
      fresh
        .prepare(ALL_STATS)
        .all(event)
        .map((r) => toGamePlayerStat(r as Record<string, unknown>));

    // Pick a player who both dealt and took combat damage, so removing them
    // exercises the dealer side of the filter and the target side. The two are
    // separate joins and a mutation test showed that asserting on one leaves
    // the other free.
    const before = read();
    const victim = before.find((r) => r.combat_dmg_dealt > 0 && r.combat_dmg_taken > 0)!;
    const inGame = (rows: GamePlayerStat[]) => rows.filter((r) => r.game_id === victim.game_id);
    const sum = (rows: GamePlayerStat[], f: "combat_dmg_dealt" | "combat_dmg_taken") =>
      rows.reduce((n, r) => n + r[f], 0);

    // Every point dealt to a seated player is a point taken by one, so the two
    // sides of the table balance. Asserted because the arithmetic below rests
    // on it.
    expect(sum(inGame(before), "combat_dmg_dealt")).toBe(sum(inGame(before), "combat_dmg_taken"));

    const player_id = fixture.raw["players"]!.find((p) => p["name"] === victim.player)!["player_id"] as number;
    reseatAway(fresh, victim.game_id, player_id);
    const after = read();

    // They are not at the table any more, so they have no row for that game.
    expect(after.find((r) => r.game_id === victim.game_id && r.player === victim.player)).toBeUndefined();

    // The table loses exactly what they dealt and exactly what they took, and
    // nothing else: what they dealt stops being taken by the opponents who
    // took it, and what they took stops being dealt by the opponents who dealt
    // it. Either join missing breaks one of these two numbers.
    const lost = victim.combat_dmg_dealt + victim.combat_dmg_taken;
    expect(sum(inGame(after), "combat_dmg_taken")).toBe(sum(inGame(before), "combat_dmg_taken") - lost);
    expect(sum(inGame(after), "combat_dmg_dealt")).toBe(sum(inGame(before), "combat_dmg_dealt") - lost);

    // Other games are untouched: this is one table's seating, not the night's.
    const others = (rows: GamePlayerStat[]) => rows.filter((r) => r.game_id !== victim.game_id);
    expect(others(after)).toEqual(others(before));
  });

  test("seating the right player back restores what was recorded", () => {
    const fresh = migrated();
    const event = seed(fresh, fixture);
    const read = () =>
      fresh
        .prepare(ALL_STATS)
        .all(event)
        .map((r) => toGamePlayerStat(r as Record<string, unknown>));

    const before = read();
    const victim = before.find((r) => r.combat_dmg_dealt > 0 && r.combat_dmg_taken > 0)!;
    const player_id = fixture.raw["players"]!.find((p) => p["name"] === victim.player)!["player_id"] as number;

    const replacement = reseatAway(fresh, victim.game_id, player_id);
    const seat = fixture.raw["game_seats"]!.find(
      (sx) => sx["game_id"] === victim.game_id && sx["player_id"] === player_id,
    )!["seat"] as number;
    fresh.prepare("DELETE FROM game_seats WHERE game_id = ? AND player_id = ?").run(victim.game_id, replacement);
    fresh.prepare("INSERT INTO game_seats (game_id, player_id, seat) VALUES (?, ?, ?)").run(
      victim.game_id,
      player_id,
      seat,
    );

    // A seating mistake corrected is a seating mistake with no consequences.
    expect(read()).toEqual(before);
  });
});

describe("constraints the old schema did not have", () => {
  test("a fifth seat can place fifth", () => {
    // The old CHECK was BETWEEN 1 AND 4 while pod_size was already
    // configurable, so a five-player pod failed on write.
    const fresh = migrated();
    seed(fresh, fixture);
    const game_id = fixture.raw["games"]![0]!["game_id"] as number;
    const spare = fixture.raw["players"]!.find(
      (p) => !fixture.raw["game_seats"]!.some(
        (s) => s["game_id"] === game_id && s["player_id"] === p["player_id"],
      ),
    )!;
    fresh.prepare("INSERT INTO game_seats (game_id, player_id, seat) VALUES (?, ?, 5)")
      .run(game_id, spare["player_id"]!);
    expect(() =>
      fresh
        .prepare("INSERT INTO game_player_stats (game_id, player_id, placement, final_life) VALUES (?, ?, 5, -3)")
        .run(game_id, spare["player_id"]!),
    ).not.toThrow();
  });

  test("a half-written tiebreak is rejected", () => {
    // A field without a direction, or the reverse, would silently fall back to
    // roster order rather than tiebreaking at all.
    const fresh = migrated();
    const event = seed(fresh, fixture);
    expect(() =>
      fresh
        .prepare(
          "INSERT INTO prizes (event_id, key, name, metric, agg, scope, tiebreak_field, position)" +
            " VALUES (?, 'half', 'Half a tiebreak', 'win_points', 'max', 'night', 'total_damage', 99)",
        )
        .run(event),
    ).toThrow(/CHECK constraint failed/);
  });

  test("damage to oneself is rejected, and so is negative damage", () => {
    const fresh = migrated();
    seed(fresh, fixture);
    const game_id = fixture.raw["games"]![0]!["game_id"] as number;
    const seats = fixture.raw["game_seats"]!.filter((s) => s["game_id"] === game_id);
    const self = seats[0]!["player_id"] as number;
    const other = seats[1]!["player_id"] as number;
    expect(() =>
      fresh
        .prepare("INSERT INTO turn_damage (game_id, player_id, round_no, target_id, combat_dmg) VALUES (?, ?, 99, ?, 5)")
        .run(game_id, self, self),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      fresh
        .prepare("INSERT INTO turn_damage (game_id, player_id, round_no, target_id, combat_dmg) VALUES (?, ?, 99, ?, -5)")
        .run(game_id, self, other),
    ).toThrow(/CHECK constraint failed/);
  });

  test("a pod a game names has to exist", () => {
    const fresh = migrated();
    const event = seed(fresh, fixture);
    expect(() =>
      fresh.prepare("INSERT INTO games (event_id, pod, match_no) VALUES (?, 'Z', 1)").run(event),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  test("two rosters cannot claim the same position", () => {
    const fresh = migrated();
    const event = seed(fresh, fixture);
    expect(() =>
      fresh
        .prepare("INSERT INTO players (event_id, name, prize_eligible, roster_position) VALUES (?, 'Ivan', 1, 1)")
        .run(event),
    ).toThrow(/UNIQUE constraint failed/);
  });

  test("final life may be very negative", () => {
    // -9997 happened, from a 9999-damage attack. A non-negativity CHECK here
    // would have rejected the real night.
    const lives = (fixture.raw["game_player_stats"] as { final_life: number }[]).map((r) => r.final_life);
    expect(Math.min(...lives)).toBeLessThan(0);
    expect(derived.some((d) => d.final_life < -1000)).toBe(true);
  });
});
