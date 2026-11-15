// Roster admin, and the danger zone.
//
// The roster lives in the database and this surface owns it: add, rename, set
// commander, set prize eligibility, delete.
//
// Deletion is refused for any player who is part of a game. Every table that
// references a player cascades, so allowing it would silently destroy that
// player's game history and leave their table a seat short. Renaming is always
// safe, because stats key on player_id.
//
// The danger zone is two-step on purpose: the first click only asks the server
// what would be destroyed, and the confirmation names the real counts before
// anything is deleted. A one-click reset next to the roster controls is a
// misclick away from ending a live event.
//
//   GET  /admin                          full page
//   POST /admin/players                  add
//   POST /admin/players/:id              rename / commander / eligibility
//   POST /admin/players/:id/delete       delete, refused if part of a game
//   GET  /admin/reset                    danger zone, idle (also Cancel)
//   GET  /admin/reset/confirm?scope=...  danger zone, armed, with real counts
//   POST /admin/reset                    do it

import { Hono } from "hono";
import type { Context } from "hono";
import {
  DuplicatePlayerName,
  addPlayer,
  clearResults,
  clearRoster,
  countResults,
  deletePlayer,
  getPlayer,
  playerHasStats,
  restorePoint,
  updatePlayer,
} from "../admin-data.ts";
import { activeEvent, roster } from "../data.ts";
import { players as loadPlayers } from "../entry-data.ts";
import { statsChanged } from "../events.ts";
import { COMMANDER_MAX } from "../fields.ts";
import {
  type AdminContext,
  NAME_MAX,
  type ResetState,
  adminPage,
  dangerZone,
  resetDone,
  rosterSection,
} from "../views/admin.ts";

export const admin = new Hono<{ Bindings: Env }>();

/** The two reset levels. */
const RESET_SCOPES = ["results", "all"];

const GONE = "That player is no longer on the roster.";
const NO_EVENT = "No event configured yet.";

/**
 * SQLite stores INTEGER as signed 64-bit, so an id wider than that cannot be
 * bound at all. Only the upper bound is checked, because the shape test below
 * already rejects anything with a sign in it.
 */
const SQLITE_INT_MAX = 9223372036854775807n;

function field(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function fieldError(name: string, commander: string): string | null {
  if (!name) return "Name is required.";
  if (name.length > NAME_MAX) return `Name must be ${NAME_MAX} characters or fewer.`;
  if (commander.length > COMMANDER_MAX) {
    return `Commander must be ${COMMANDER_MAX} characters or fewer.`;
  }
  return null;
}

/**
 * Path segment to a player id, or null.
 *
 * Strict on purpose. A path segment has no business meaning " 12 ", "1_2" or
 * the non-ASCII digits that Number() and parseInt() variously accept, and an id
 * wider than SQLite can bind would fail inside the query rather than as this
 * helper's polite refusal. BigInt is used for the range test because a Number
 * loses precision above 2^53 and would compare equal to the wrong things.
 */
function playerIdOf(raw: string): number | null {
  if (!/^[0-9]+$/.test(raw)) return null;
  const value = BigInt(raw);
  if (value > SQLITE_INT_MAX) return null;
  return Number(value);
}

async function resetState(
  db: D1Database,
  eventId: number,
  over: Partial<ResetState> = {},
): Promise<ResetState> {
  const counts = await countResults(db, eventId);
  const names = await roster(db, eventId);
  return {
    armed: null,
    games: counts.games,
    stat_rows: counts.stat_rows,
    player_count: names.length,
    reset_notice: null,
    reset_error: null,
    ...over,
  };
}

async function context(
  db: D1Database,
  over: Partial<AdminContext> = {},
): Promise<AdminContext | null> {
  const event = await activeEvent(db);
  if (!event) return null;
  const [state, players] = await Promise.all([
    resetState(db, event.event_id),
    loadPlayers(db, event.event_id),
  ]);
  return {
    ...state,
    event,
    players,
    error: null,
    notice: null,
    form: { name: "", commander: "" },
    ...over,
  };
}

/** Re-render the roster region, which is what every roster action swaps. */
async function rosterResponse(
  c: Context<{ Bindings: Env }>,
  over: Partial<AdminContext>,
  status: 200 | 422 = 200,
): Promise<Response> {
  const ctx = await context(c.env.DB, over);
  if (!ctx) return c.text(NO_EVENT, 503);
  return c.html(rosterSection(ctx), status);
}

admin.get("/", async (c) => {
  const ctx = await context(c.env.DB);
  if (!ctx) return c.text(NO_EVENT, 503);
  return c.html(adminPage(ctx));
});

admin.post("/players", async (c) => {
  const form = await c.req.formData();
  const name = field(form, "name");
  const commander = field(form, "commander");
  const eligible = form.get("prize_eligible") !== null;
  const typed = { name, commander };

  const problem = fieldError(name, commander);
  if (problem !== null) {
    return await rosterResponse(c, { error: problem, form: typed }, 422);
  }

  const event = await activeEvent(c.env.DB);
  if (!event) return c.text(NO_EVENT, 503);
  try {
    await addPlayer(c.env.DB, event.event_id, name, commander || null, eligible);
  } catch (e) {
    if (!(e instanceof DuplicatePlayerName)) throw e;
    return await rosterResponse(
      c,
      { error: `A player named '${name}' is already on the roster.`, form: typed },
      422,
    );
  }

  // The projected display builds its standings from the roster, so a change
  // that did not publish would leave a stale name on the projector until the
  // next stat save.
  await statsChanged(c);
  return await rosterResponse(c, { notice: `Added ${name}.` });
});

admin.post("/players/:id", async (c) => {
  const form = await c.req.formData();
  const name = field(form, "name");
  const commander = field(form, "commander");
  // An unchecked checkbox sends nothing, which is how a box is unticked.
  const eligible = form.get("prize_eligible") !== null;

  const event = await activeEvent(c.env.DB);
  if (!event) return c.text(NO_EVENT, 503);
  const id = playerIdOf(c.req.param("id"));
  // Scoped by event: a stale tab or a hand-crafted post must not reach a
  // player belonging to another event.
  const player = id === null ? null : await getPlayer(c.env.DB, event.event_id, id);
  if (player === null) return await rosterResponse(c, { error: GONE }, 422);

  const problem = fieldError(name, commander);
  if (problem !== null) {
    return await rosterResponse(
      c,
      { error: `${player.name} was not changed. ${problem}` },
      422,
    );
  }

  // No rename guard: eligibility is a column on the player and is on this
  // form, so a rename cannot change it.
  try {
    await updatePlayer(
      c.env.DB,
      event.event_id,
      player.player_id,
      name,
      commander || null,
      eligible,
    );
  } catch (e) {
    if (!(e instanceof DuplicatePlayerName)) throw e;
    return await rosterResponse(
      c,
      { error: `A player named '${name}' is already on the roster.` },
      422,
    );
  }

  await statsChanged(c);
  return await rosterResponse(c, { notice: `Saved ${name}.` });
});

admin.post("/players/:id/delete", async (c) => {
  const event = await activeEvent(c.env.DB);
  if (!event) return c.text(NO_EVENT, 503);
  const id = playerIdOf(c.req.param("id"));
  const player = id === null ? null : await getPlayer(c.env.DB, event.event_id, id);
  if (player === null) return await rosterResponse(c, { error: GONE }, 422);

  // Pre-check only, so the operator gets the specific reason. The refusal
  // itself is the delete statement's, which cannot be trusted to still hold by
  // the time it runs.
  if (await playerHasStats(c.env.DB, player.player_id)) {
    return await rosterResponse(
      c,
      {
        error:
          `${player.name} is part of a game and cannot be deleted: it would ` +
          "take their seat and stats with them. Rename them instead, or " +
          "reseat that table without them.",
      },
      422,
    );
  }

  // A false here means the row was not removed, and "is part of a game" is
  // only one of the reasons: another admin deleting the same player first also
  // lands here. Naming a cause we did not establish would be a lie in a
  // two-admin race, so the message stays generic and points at the freshly
  // rendered roster.
  if (!(await deletePlayer(c.env.DB, event.event_id, player.player_id))) {
    return await rosterResponse(
      c,
      { error: `${player.name} could not be deleted. The roster below is current.` },
      422,
    );
  }

  await statsChanged(c);
  return await rosterResponse(c, { notice: `Deleted ${player.name}.` });
});

// --- danger zone -------------------------------------------------------------
//
// Two steps, both server-rendered. The GET arms the panel and reports what is
// actually in the database right now; the POST carries the scope it was armed
// with. An hx-confirm dialog would have been one line, but it can only promise
// "this will reset everything": it cannot tell the operator they are about to
// lose 24 stat rows across 6 games, which is the number that makes somebody
// stop and think. Arming is a GET on purpose, because it reads and changes
// nothing, so a double-click, a refresh or a stray prefetch cannot destroy
// anything.

async function dangerResponse(
  c: Context<{ Bindings: Env }>,
  over: Partial<ResetState> = {},
  status: 200 | 422 = 200,
): Promise<Response> {
  const event = await activeEvent(c.env.DB);
  if (!event) return c.text(NO_EVENT, 503);
  return c.html(dangerZone(await resetState(c.env.DB, event.event_id, over)), status);
}

/** The idle panel. Also the Cancel target. */
admin.get("/reset", async (c) => await dangerResponse(c));

admin.get("/reset/confirm", async (c) => {
  const scope = c.req.query("scope") ?? "results";
  if (!RESET_SCOPES.includes(scope)) {
    return await dangerResponse(c, { reset_error: "Unknown reset type." }, 422);
  }
  return await dangerResponse(c, { armed: scope });
});

admin.post("/reset", async (c) => {
  const form = await c.req.formData();
  const scope = field(form, "scope");
  if (!RESET_SCOPES.includes(scope)) {
    return await dangerResponse(c, { reset_error: "Unknown reset type." }, 422);
  }

  const event = await activeEvent(c.env.DB);
  if (!event) return c.text(NO_EVENT, 503);
  const eventId = event.event_id;

  // Before anything is deleted. The operator has confirmed, which is not the
  // same as being right.
  const bookmark = await restorePoint(c.env.DB);

  const destroyed = await clearResults(c.env.DB, eventId);
  let done =
    `Deleted ${destroyed.stat_rows} stat row${destroyed.stat_rows === 1 ? "" : "s"} ` +
    `across ${destroyed.games} game${destroyed.games === 1 ? "" : "s"}`;

  if (scope === "all") {
    const removed = await clearRoster(c.env.DB, eventId);
    // The event row is deliberately kept: deleting it would take the
    // active_event pointer with it and leave every surface answering 503.
    // There is no config roster to reseed from any more, so the roster stays
    // empty and the confirmation said so.
    done += `; removed ${removed} player${removed === 1 ? "" : "s"}, roster now empty`;
  }

  // Both surfaces are stale now. The display rebuilds standings from the
  // roster as well as the stats, so a results-only reset still has to say so.
  await statsChanged(c);

  const where = bookmark
    ? `Restore point: ${bookmark} (wrangler d1 time-travel restore ${"commander-tracker"} --bookmark=<it>)`
    : `Restore by time: ${new Date().toISOString()} (wrangler d1 time-travel restore)`;

  const ctx = await context(c.env.DB, {
    notice: scope === "all" ? "Roster cleared." : null,
    reset_notice: `${done}. ${where}`,
  });
  if (!ctx) return c.text(NO_EVENT, 503);
  return c.html(resetDone(ctx));
});
