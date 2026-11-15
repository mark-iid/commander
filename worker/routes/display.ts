// The public display surface: the projected leaderboard.
//
// Read-only. Renders every configured prize with its current winner plus the
// win-point standings, and pushes a fresh copy over SSE whenever a tracker
// saves an entry.
//
//   GET /display         the projected page
//   GET /display/stream  SSE; emits a `leaderboard` event carrying the partial
//
// The stream sends rendered HTML rather than JSON, because the scoring engine
// already owns who is winning, so the browser needs no logic of its own.

import { Hono } from "hono";
import { buildStandings, rankedStandings, resolvePrize } from "../../shared/scoring.ts";
import { activeEvent, allStats, gamesRecorded, roster, scoringConfig } from "../data.ts";
import { boardStub, renderBoard } from "../events.ts";
import { type BoardData, displayPage } from "../views/display.ts";

export const display = new Hono<{ Bindings: Env }>();

/**
 * Everything the board shows, for one event.
 *
 * Exported because phase 3's push renders the same data through the same
 * function: one definition of what the room sees.
 */
export async function boardData(db: D1Database, eventId: number): Promise<BoardData | null> {
  const [event, names, config, stats, recorded] = await Promise.all([
    activeEvent(db),
    roster(db, eventId),
    scoringConfig(db, eventId),
    allStats(db, eventId),
    gamesRecorded(db, eventId),
  ]);
  if (!event) return null;

  const standings = buildStandings(stats, config, names);
  return {
    event,
    standings: rankedStandings(standings),
    // resolvePrize against the standings already built, rather than
    // leaderboard() per prize, which would recompute them eleven times.
    // Neither it nor rankedStandings reorders the array it is given, which
    // matters: roster order is the last-resort tiebreaker.
    prizes: config.prizes.map((p) => resolvePrize(p, standings, config.prize_ineligible)),
    gamesRecorded: recorded,
  };
}

display.get("/", async (c) => {
  const event = await activeEvent(c.env.DB);
  if (!event) return c.text("No event configured yet.", 503);
  const data = await boardData(c.env.DB, event.event_id);
  if (!data) return c.text("No event configured yet.", 503);
  return c.html(displayPage(data));
});

/**
 * The stream the projector holds open all evening.
 *
 * The board is rendered here and handed to the Durable Object with the
 * subscribe request, so a browser that connects between saves is correct
 * immediately rather than blank until the next one. Everything after that
 * arrives as a push.
 *
 * Nothing is polled. The connection is held by the object, not by this
 * handler, so the Worker invocation that opened it ends straight away.
 */
display.get("/stream", async (c) => {
  const html = await renderBoard(c.env.DB);
  if (html === null) return c.text("No event configured yet.", 503);
  return await boardStub(c.env).fetch("https://board.invalid/subscribe", {
    method: "POST",
    body: html,
  });
});
