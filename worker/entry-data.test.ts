// The entry surface's writes, against real D1.
//
// These are the paths two trackers hit simultaneously all evening, and the ones
// where a mistake is destructive rather than merely wrong: a reseat that drops
// recorded turns, a correction that leaves an old damage value behind, a double
// kill whose second row never lands.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { ALL_STATS, toGamePlayerStat } from "../shared/aggregate.ts";
import {
  commandersForMatch,
  finalFor,
  findGame,
  getOrCreateGame,
  playerIds,
  roundsPlayed,
  saveFinals,
  saveMatchCommanders,
  saveTurn,
  seatPlayers,
  seatedElsewhere,
  turnFor,
  turnGrid,
} from "./entry-data.ts";
import { enteredKey } from "./entry-rules.ts";
import { TABLE, minimalEvent, type Minimal } from "./test/minimal.ts";
import { resetDatabase } from "./test/reset.ts";

let ev: Minimal;
const db = () => env.DB;

const turn = (round: number, over: Partial<Parameters<typeof saveTurn>[3]> = {}) => ({
  round_no: round,
  attacking_creatures: 0,
  cmdr_dmg_dealt: 0,
  noncombat_dmg_dealt: 0,
  opps_eliminated: 0,
  damage: new Map<string, number>(),
  ...over,
});

async function seatAll(gameId: number, names = TABLE): Promise<void> {
  await seatPlayers(
    db(),
    gameId,
    names.map((n) => ev.ids.get(n)!),
  );
}

beforeEach(async () => {
  await resetDatabase(db());
  ev = await minimalEvent(db());
});

describe("finding and creating a table", () => {
  test("a game is created once and found after that", async () => {
    expect(await findGame(db(), 1, "A", 1)).toBeNull();
    const id = await getOrCreateGame(db(), 1, "A", 1);
    expect(id).toBeGreaterThan(0);
    expect(await getOrCreateGame(db(), 1, "A", 1)).toBe(id);
    expect(await findGame(db(), 1, "A", 1)).toBe(id);
  });

  test("two trackers opening the same table get the same game", async () => {
    // The normal case, not an edge one: two pods, two trackers, one event.
    // The unique index on (event_id, pod, match_no) is what makes it safe.
    const [a, b, c] = await Promise.all([
      getOrCreateGame(db(), 1, "A", 2),
      getOrCreateGame(db(), 1, "A", 2),
      getOrCreateGame(db(), 1, "A", 2),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    const { results } = await db()
      .prepare("SELECT COUNT(*) AS n FROM games WHERE event_id = 1")
      .all<{ n: number }>();
    expect(results[0]!.n).toBe(1);
  });
});

describe("seating", () => {
  test("seats are numbered in the order given, which is turn order", async () => {
    const game = await getOrCreateGame(db(), 1, "A", 1);
    await seatAll(game, ["Dan", "Cat", "Ben", "Ann"]);
    const { results } = await db()
      .prepare(
        `SELECT p.name, s.seat FROM game_seats s JOIN players p ON p.player_id = s.player_id
         WHERE s.game_id = ? ORDER BY s.seat`,
      )
      .bind(game)
      .all<{ name: string; seat: number }>();
    expect(results.map((r) => r.name)).toEqual(["Dan", "Cat", "Ben", "Ann"]);
    expect(results.map((r) => r.seat)).toEqual([1, 2, 3, 4]);
  });

  test("a reseat deletes nothing, and seating the player back restores it", async () => {
    // The destructive version of this would lose turns mid-game.
    const game = await getOrCreateGame(db(), 1, "A", 1);
    await seatAll(game);
    await saveTurn(
      db(),
      game,
      ev.ids.get("Ann")!,
      turn(1, { damage: new Map([["Ben", 7]]), attacking_creatures: 2 }),
      ev.ids,
    );

    const read = async () =>
      (await db().prepare(ALL_STATS).bind(1).all()).results.map((r) =>
        toGamePlayerStat(r as Record<string, unknown>),
      );
    const before = await read();

    // Ann off the table.
    await seatAll(game, ["Ben", "Cat", "Dan"]);
    const without = await read();
    expect(without.find((r) => r.player === "Ann")).toBeUndefined();
    expect(without.find((r) => r.player === "Ben")!.combat_dmg_taken).toBe(0);
    // The turn row is still there; it is only not counted.
    const row = await db()
      .prepare("SELECT COUNT(*) AS n FROM turn_stats WHERE game_id = ?")
      .bind(game)
      .first<{ n: number }>();
    expect(row!.n).toBe(1);

    await seatAll(game);
    expect(await read()).toEqual(before);
  });

  test("clearing a table frees its players for the other pod", async () => {
    // Without this a swap between pods deadlocks once all the players are
    // dealt: each table refuses the player the other one holds.
    const a = await getOrCreateGame(db(), 1, "A", 1);
    await seatAll(a);
    expect(await seatedElsewhere(db(), 1, 1, null)).toEqual(new Set(TABLE));
    await seatPlayers(db(), a, []);
    expect(await seatedElsewhere(db(), 1, 1, null)).toEqual(new Set());
  });

  test("seated elsewhere excludes this table but not the other pod", async () => {
    const a = await getOrCreateGame(db(), 1, "A", 1);
    const b = await getOrCreateGame(db(), 1, "B", 1);
    await seatPlayers(db(), a, [ev.ids.get("Ann")!, ev.ids.get("Ben")!]);
    await seatPlayers(db(), b, [ev.ids.get("Cat")!]);
    expect(await seatedElsewhere(db(), 1, 1, a)).toEqual(new Set(["Cat"]));
    expect(await seatedElsewhere(db(), 1, 1, b)).toEqual(new Set(["Ann", "Ben"]));
    // A table nobody has opened yet is the second pod of every match: then
    // everyone seated anywhere is elsewhere.
    expect(await seatedElsewhere(db(), 1, 1, null)).toEqual(new Set(["Ann", "Ben", "Cat"]));
    // A different match is unaffected: seating rotates.
    expect(await seatedElsewhere(db(), 1, 2, null)).toEqual(new Set());
  });
});

describe("saving a turn", () => {
  test("it upserts, and a correction to zero removes the damage row", async () => {
    // An upsert alone would leave the old value behind, so a tracker fixing a
    // mistyped 70 to 0 would still be scoring 70.
    const game = await getOrCreateGame(db(), 1, "A", 1);
    await seatAll(game);
    const ann = ev.ids.get("Ann")!;

    await saveTurn(db(), game, ann, turn(1, { damage: new Map([["Ben", 70]]) }), ev.ids);
    expect((await turnFor(db(), game, "Ann", 1))!.damage.get("Ben")).toBe(70);

    await saveTurn(db(), game, ann, turn(1, { damage: new Map([["Ben", 0]]) }), ev.ids);
    const after = await turnFor(db(), game, "Ann", 1);
    expect(after!.damage.size).toBe(0);
    const row = await db()
      .prepare("SELECT COUNT(*) AS n FROM turn_damage WHERE game_id = ?")
      .bind(game)
      .first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  test("it refuses damage to oneself", async () => {
    const game = await getOrCreateGame(db(), 1, "A", 1);
    await seatAll(game);
    await expect(
      saveTurn(db(), game, ev.ids.get("Ann")!, turn(1, { damage: new Map([["Ann", 5]]) }), ev.ids),
    ).rejects.toThrow(/themselves/);
  });

  test("the damage delete spares a hit on somebody reseated away", async () => {
    // The form shows no box for a player who has left the table, so their hit
    // was not resubmitted. Deleting it would make the reseat destructive.
    const game = await getOrCreateGame(db(), 1, "A", 1);
    await seatAll(game);
    const ann = ev.ids.get("Ann")!;
    await saveTurn(
      db(),
      game,
      ann,
      turn(1, { damage: new Map([["Ben", 5], ["Cat", 6]]) }),
      ev.ids,
    );

    // Cat leaves the table, then Ann's turn is re-saved without Cat's box.
    await seatAll(game, ["Ann", "Ben", "Dan"]);
    await saveTurn(db(), game, ann, turn(1, { damage: new Map([["Ben", 5]]) }), ev.ids);

    // Cat's row survives, so seating her back restores her damage.
    await seatAll(game);
    const grid = await turnGrid(db(), game);
    expect(grid.get(enteredKey("Ann", 1))!.damage.get("Cat")).toBe(6);
  });

  test("rounds played is the table's counter, and ignores unseated turns", async () => {
    const game = await getOrCreateGame(db(), 1, "A", 1);
    await seatAll(game);
    expect(await roundsPlayed(db(), game)).toBe(0);
    await saveTurn(db(), game, ev.ids.get("Ann")!, turn(1), ev.ids);
    await saveTurn(db(), game, ev.ids.get("Ben")!, turn(3), ev.ids);
    expect(await roundsPlayed(db(), game)).toBe(3);
    // Ben off the table: his round 3 stops counting.
    await seatAll(game, ["Ann", "Cat", "Dan"]);
    expect(await roundsPlayed(db(), game)).toBe(1);
  });
});

describe("the death and win section", () => {
  test("a double kill is written as one group", async () => {
    // Their placements are one fact split across two rows: the finishing
    // order. Half of it landing would leave a placement that order never
    // produced.
    const game = await getOrCreateGame(db(), 1, "A", 1);
    await seatAll(game);
    await saveFinals(
      db(),
      game,
      new Map([
        [ev.ids.get("Dan")!, { placement: 3, final_life: -5, total_graveyard: 11 }],
        [ev.ids.get("Cat")!, { placement: 3, final_life: -5, total_graveyard: 9 }],
      ]),
    );
    expect(await finalFor(db(), game, "Dan")).toEqual({
      placement: 3,
      final_life: -5,
      total_graveyard: 11,
    });
    expect((await finalFor(db(), game, "Cat"))!.placement).toBe(3);
    // Nobody else is touched: they are mid-game and have no placement, which
    // is what scoring reads as still playing.
    expect(await finalFor(db(), game, "Ann")).toBeNull();
  });

  test("a re-save corrects the row rather than adding one", async () => {
    const game = await getOrCreateGame(db(), 1, "A", 1);
    await seatAll(game);
    const dan = ev.ids.get("Dan")!;
    await saveFinals(db(), game, new Map([[dan, { placement: 4, final_life: -1, total_graveyard: 3 }]]));
    await saveFinals(db(), game, new Map([[dan, { placement: 4, final_life: -9, total_graveyard: 4 }]]));
    expect(await finalFor(db(), game, "Dan")).toEqual({
      placement: 4,
      final_life: -9,
      total_graveyard: 4,
    });
    const row = await db()
      .prepare("SELECT COUNT(*) AS n FROM game_player_stats WHERE game_id = ?")
      .bind(game)
      .first<{ n: number }>();
    expect(row!.n).toBe(1);
  });

  test("a very negative life is stored as given", async () => {
    // -9997 happened. A clamp or an unsigned column would have lost the game
    // it was reached in.
    const game = await getOrCreateGame(db(), 1, "A", 1);
    await seatAll(game);
    await saveFinals(
      db(),
      game,
      new Map([[ev.ids.get("Dan")!, { placement: 4, final_life: -9997, total_graveyard: 0 }]]),
    );
    expect((await finalFor(db(), game, "Dan"))!.final_life).toBe(-9997);
  });
});

describe("the decks of a match", () => {
  test("a deck is recorded per player per match", async () => {
    await saveMatchCommanders(
      db(),
      1,
      2,
      new Map([
        [ev.ids.get("Ann")!, "Kaalia of the Vast"],
        [ev.ids.get("Ben")!, "Niv-Mizzet, Parun"],
      ]),
    );
    expect(await commandersForMatch(db(), 1, 2)).toEqual(
      new Map([
        ["Ann", "Kaalia of the Vast"],
        ["Ben", "Niv-Mizzet, Parun"],
      ]),
    );
    // A different match is a different deck: players may bring one each.
    expect(await commandersForMatch(db(), 1, 1)).toEqual(new Map());
  });

  test("a blank box deletes the row rather than storing an empty string", async () => {
    // So "no deck recorded" is one state and not two.
    const ann = ev.ids.get("Ann")!;
    await saveMatchCommanders(db(), 1, 1, new Map([[ann, "Chatterfang"]]));
    await saveMatchCommanders(db(), 1, 1, new Map([[ann, "   "]]));
    expect(await commandersForMatch(db(), 1, 1)).toEqual(new Map());
  });

  test("whitespace around a deck name is trimmed", async () => {
    await saveMatchCommanders(db(), 1, 1, new Map([[ev.ids.get("Ann")!, "  Doran  "]]));
    expect(await commandersForMatch(db(), 1, 1)).toEqual(new Map([["Ann", "Doran"]]));
  });
});

describe("the turn grid", () => {
  test("it keys every recorded turn by player and round", async () => {
    const game = await getOrCreateGame(db(), 1, "A", 1);
    await seatAll(game);
    await saveTurn(db(), game, ev.ids.get("Ann")!, turn(1, { opps_eliminated: 1 }), ev.ids);
    await saveTurn(db(), game, ev.ids.get("Ann")!, turn(2), ev.ids);
    await saveTurn(db(), game, ev.ids.get("Ben")!, turn(1, { damage: new Map([["Ann", 3]]) }), ev.ids);

    const grid = await turnGrid(db(), game);
    expect([...grid.keys()].sort()).toEqual(
      [enteredKey("Ann", 1), enteredKey("Ann", 2), enteredKey("Ben", 1)].sort(),
    );
    expect(grid.get(enteredKey("Ann", 1))!.opps_eliminated).toBe(1);
    expect(grid.get(enteredKey("Ben", 1))!.damage.get("Ann")).toBe(3);
  });
});

describe("the roster", () => {
  test("player ids are keyed by the names the forms use", async () => {
    const ids = await playerIds(db(), 1);
    expect([...ids.keys()].sort()).toEqual([...TABLE].sort());
  });
});
