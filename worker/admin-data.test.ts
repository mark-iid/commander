// The delete guard, tested where it actually lives.
//
// worker/routes/admin.test.ts covers the operator's experience, but it cannot
// reach this: the route pre-checks playerHasStats and refuses before the delete
// runs, so removing the guard from the DELETE statement itself leaves every
// route test green. Verified by mutation.
//
// The guard has to be in the statement because the pre-check is a
// time-of-check/time-of-use race: a tracker saving that player's first stat row
// in the window between the two would have their whole game silently cascaded
// away. These tests call the statement directly, with no pre-check in front of
// it, which is the only way to hold it.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { deletePlayer, playerHasStats } from "./admin-data.ts";
import { minimalEvent, type Minimal } from "./test/minimal.ts";
import { resetDatabase } from "./test/reset.ts";

let ev: Minimal;
const db = () => env.DB;

async function newGame(): Promise<number> {
  const result = await db()
    .prepare("INSERT INTO games (event_id, pod, match_no) VALUES (1, 'A', 1)")
    .run();
  return Number(result.meta.last_row_id);
}

beforeEach(async () => {
  await resetDatabase(db());
  ev = await minimalEvent(db());
});

describe("a player who is part of a game", () => {
  test("a free player is deleted", async () => {
    expect(await playerHasStats(db(), ev.ids.get("Dan")!)).toBe(false);
    expect(await deletePlayer(db(), 1, ev.ids.get("Dan")!)).toBe(true);
  });

  // Each of the four ways, because each one cascades and each one is a
  // separate clause in the guard.
  test("seated at a table", async () => {
    const game = await newGame();
    await db()
      .prepare("INSERT INTO game_seats (game_id, player_id, seat) VALUES (?, ?, 1)")
      .bind(game, ev.ids.get("Ann")!)
      .run();
    expect(await playerHasStats(db(), ev.ids.get("Ann")!)).toBe(true);
    expect(await deletePlayer(db(), 1, ev.ids.get("Ann")!)).toBe(false);
  });

  test("with a turn of their own", async () => {
    const game = await newGame();
    await db()
      .prepare(
        "INSERT INTO turn_stats (game_id, player_id, round_no, attacking_creatures) VALUES (?, ?, 1, 1)",
      )
      .bind(game, ev.ids.get("Ben")!)
      .run();
    expect(await playerHasStats(db(), ev.ids.get("Ben")!)).toBe(true);
    expect(await deletePlayer(db(), 1, ev.ids.get("Ben")!)).toBe(false);
  });

  test("hit by somebody else's turn", async () => {
    // A hit taken is another player's combat damage, so deleting the target
    // would quietly reduce the dealer's score.
    const game = await newGame();
    await db().batch([
      db()
        .prepare("INSERT INTO game_seats (game_id, player_id, seat) VALUES (?, ?, 1)")
        .bind(game, ev.ids.get("Ann")!),
      db()
        .prepare("INSERT INTO game_seats (game_id, player_id, seat) VALUES (?, ?, 2)")
        .bind(game, ev.ids.get("Cat")!),
      db()
        .prepare(
          "INSERT INTO turn_damage (game_id, player_id, round_no, target_id, combat_dmg) VALUES (?, ?, 1, ?, 5)",
        )
        .bind(game, ev.ids.get("Ann")!, ev.ids.get("Cat")!),
    ]);
    expect(await playerHasStats(db(), ev.ids.get("Cat")!)).toBe(true);
    expect(await deletePlayer(db(), 1, ev.ids.get("Cat")!)).toBe(false);
  });

  test("with a death or win row", async () => {
    const game = await newGame();
    await db()
      .prepare(
        "INSERT INTO game_player_stats (game_id, player_id, placement, final_life) VALUES (?, ?, 4, -2)",
      )
      .bind(game, ev.ids.get("Dan")!)
      .run();
    expect(await playerHasStats(db(), ev.ids.get("Dan")!)).toBe(true);
    expect(await deletePlayer(db(), 1, ev.ids.get("Dan")!)).toBe(false);
  });

  test("the row really is still there after a refusal", async () => {
    const game = await newGame();
    await db()
      .prepare("INSERT INTO game_seats (game_id, player_id, seat) VALUES (?, ?, 1)")
      .bind(game, ev.ids.get("Ann")!)
      .run();
    await deletePlayer(db(), 1, ev.ids.get("Ann")!);
    const row = await db()
      .prepare("SELECT COUNT(*) AS n FROM players WHERE player_id = ?")
      .bind(ev.ids.get("Ann")!)
      .first<{ n: number }>();
    expect(row!.n).toBe(1);
  });

  test("another event's player is not reachable", async () => {
    // Scoped by event: a hand-crafted post must not delete across events.
    await db()
      .prepare("INSERT INTO events (event_id, name) VALUES (2, 'Other night')")
      .run();
    expect(await deletePlayer(db(), 2, ev.ids.get("Dan")!)).toBe(false);
    const row = await db()
      .prepare("SELECT COUNT(*) AS n FROM players WHERE player_id = ?")
      .bind(ev.ids.get("Dan")!)
      .first<{ n: number }>();
    expect(row!.n).toBe(1);
  });
});
