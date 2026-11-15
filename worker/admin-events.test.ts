// Creating, switching and deleting events, at the statement level.
//
// The source event is the real Fall 2026 night, so "copied the configuration"
// is checked against eleven real prizes rather than a hand-built one or two.
// deleteEvent's refusal of the active event is tested here, directly, for the
// same reason as the player delete guard in admin-data.test.ts: the route
// pre-checks first, so only a call with nothing in front of it can hold it.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import {
  activateEvent,
  createEvent,
  deleteEvent,
  eventSummaries,
  updateEvent,
} from "./admin-data.ts";
import { activeEvent } from "./data.ts";
import { resetDatabase } from "./test/reset.ts";
import { seedFixture } from "./test/seed.ts";

const db = () => env.DB;
let source: number;

// Every table that hangs off an event, and how to count one event's rows in it.
const PER_EVENT: Record<string, string> = {
  pods: "SELECT COUNT(*) AS n FROM pods WHERE event_id = ?",
  placement_points: "SELECT COUNT(*) AS n FROM placement_points WHERE event_id = ?",
  total_damage_fields: "SELECT COUNT(*) AS n FROM total_damage_fields WHERE event_id = ?",
  prizes: "SELECT COUNT(*) AS n FROM prizes WHERE event_id = ?",
  players: "SELECT COUNT(*) AS n FROM players WHERE event_id = ?",
  games: "SELECT COUNT(*) AS n FROM games WHERE event_id = ?",
  match_commanders: "SELECT COUNT(*) AS n FROM match_commanders WHERE event_id = ?",
  game_seats:
    "SELECT COUNT(*) AS n FROM game_seats WHERE game_id IN (SELECT game_id FROM games WHERE event_id = ?)",
  turn_stats:
    "SELECT COUNT(*) AS n FROM turn_stats WHERE game_id IN (SELECT game_id FROM games WHERE event_id = ?)",
  turn_damage:
    "SELECT COUNT(*) AS n FROM turn_damage WHERE game_id IN (SELECT game_id FROM games WHERE event_id = ?)",
  game_player_stats:
    "SELECT COUNT(*) AS n FROM game_player_stats WHERE game_id IN (SELECT game_id FROM games WHERE event_id = ?)",
};

async function counts(eventId: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [table, sql] of Object.entries(PER_EVENT)) {
    out[table] = (await db().prepare(sql).bind(eventId).first<{ n: number }>())!.n;
  }
  return out;
}

const SOURCE_COUNTS = {
  pods: 2,
  placement_points: 4,
  total_damage_fields: 1,
  prizes: 11,
  players: 8,
  games: 6,
  match_commanders: 24,
  game_seats: 24,
  turn_stats: 156,
  turn_damage: 50,
  game_player_stats: 24,
};

async function rows(sql: string, eventId: number): Promise<unknown[]> {
  return (await db().prepare(sql).bind(eventId).all()).results.map((r) => {
    const { event_id: _drop, player_id: _id, ...rest } = r as Record<string, unknown>;
    return rest;
  });
}

beforeEach(async () => {
  await resetDatabase(db());
  source = await seedFixture(db());
});

const NEW = { name: "Spring Night", date: "2027-03-14", copyRoster: true, makeActive: true };

describe("creating an event", () => {
  test("copies the configuration and roster, and no results", async () => {
    const id = (await createEvent(db(), { ...NEW, copyFrom: source }))!;
    expect(id).not.toBe(source);
    expect(await counts(id)).toEqual({
      ...SOURCE_COUNTS,
      games: 0,
      match_commanders: 0,
      game_seats: 0,
      turn_stats: 0,
      turn_damage: 0,
      game_player_stats: 0,
    });
    for (const sql of [
      "SELECT * FROM pods WHERE event_id = ? ORDER BY position",
      "SELECT * FROM placement_points WHERE event_id = ? ORDER BY placement",
      "SELECT * FROM total_damage_fields WHERE event_id = ? ORDER BY position",
      "SELECT * FROM prizes WHERE event_id = ? ORDER BY position",
      "SELECT * FROM players WHERE event_id = ? ORDER BY roster_position",
    ]) {
      expect(await rows(sql, id), sql).toEqual(await rows(sql, source));
    }
    const ev = await db().prepare("SELECT * FROM events WHERE event_id = ?").bind(id).first();
    const src = await db().prepare("SELECT * FROM events WHERE event_id = ?").bind(source).first();
    expect(ev).toMatchObject({
      name: "Spring Night",
      date: "2027-03-14",
      games_per_player: src!["games_per_player"],
      pod_size: src!["pod_size"],
      archived_at: null,
    });
  });

  test("leaves the source event exactly as it was", async () => {
    await createEvent(db(), { ...NEW, copyFrom: source });
    expect(await counts(source)).toEqual(SOURCE_COUNTS);
  });

  test("can start with an empty roster", async () => {
    const id = (await createEvent(db(), { ...NEW, copyRoster: false, copyFrom: source }))!;
    expect((await counts(id)).players).toBe(0);
    expect((await counts(id)).prizes).toBe(11);
  });

  test("becomes active only when asked", async () => {
    const quiet = (await createEvent(db(), { ...NEW, makeActive: false, copyFrom: source }))!;
    expect((await activeEvent(db()))!.event_id).toBe(source);
    const loud = (await createEvent(db(), { ...NEW, name: "Loud", copyFrom: source }))!;
    expect((await activeEvent(db()))!.event_id).toBe(loud);
    expect(quiet).not.toBe(loud);
  });

  test("from an event that does not exist creates nothing", async () => {
    expect(await createEvent(db(), { ...NEW, copyFrom: 999 })).toBeNull();
    expect((await eventSummaries(db())).length).toBe(1);
  });
});

describe("switching and editing", () => {
  test("activating moves the pointer, and an unknown id leaves it alone", async () => {
    const id = (await createEvent(db(), { ...NEW, makeActive: false, copyFrom: source }))!;
    expect(await activateEvent(db(), id)).toBe(true);
    expect((await activeEvent(db()))!.event_id).toBe(id);
    expect(await activateEvent(db(), 999)).toBe(false);
    expect((await activeEvent(db()))!.event_id).toBe(id);
  });

  test("renaming changes the name and date and nothing else", async () => {
    expect(await updateEvent(db(), source, "November 2026", null)).toBe(true);
    const ev = await db().prepare("SELECT name, date FROM events WHERE event_id = ?").bind(source).first();
    expect(ev).toEqual({ name: "November 2026", date: null });
    expect(await counts(source)).toEqual(SOURCE_COUNTS);
    expect(await updateEvent(db(), 999, "x", null)).toBe(false);
  });

  test("the summaries count each event and mark the active one", async () => {
    const id = (await createEvent(db(), { ...NEW, copyRoster: false, copyFrom: source }))!;
    const list = await eventSummaries(db());
    expect(list.map((e) => [e.event_id, e.games, e.players, e.active])).toEqual([
      [id, 0, 0, true],
      [source, 6, 8, false],
    ]);
  });
});

describe("deleting an event", () => {
  test("removes everything in it and nothing in any other event", async () => {
    const id = (await createEvent(db(), { ...NEW, copyFrom: source }))!;
    // The new one is active, so the recorded night is the one that can go.
    expect(await deleteEvent(db(), source)).toBe(true);
    expect(Object.values(await counts(source)).every((n) => n === 0)).toBe(true);
    expect((await counts(id)).prizes).toBe(11);
    expect((await counts(id)).players).toBe(8);
    expect((await eventSummaries(db())).map((e) => e.event_id)).toEqual([id]);
  });

  test("the statement itself refuses the active event", async () => {
    await createEvent(db(), { ...NEW, makeActive: false, copyFrom: source });
    expect(await deleteEvent(db(), source)).toBe(false);
    expect(await counts(source)).toEqual(SOURCE_COUNTS);
  });

  test("the fallback active event is protected too, with no pointer set", async () => {
    // With the pointer gone, activeEvent falls back to the newest event that is
    // not archived. Deleting that one is the same mid-night failure.
    const id = (await createEvent(db(), { ...NEW, makeActive: false, copyFrom: source }))!;
    await db().prepare("DELETE FROM active_event").run();
    expect((await activeEvent(db()))!.event_id).toBe(id);
    expect(await deleteEvent(db(), id)).toBe(false);
    expect(await deleteEvent(db(), source)).toBe(true);
  });
});
