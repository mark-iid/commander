// The landing page.
//
// Public, so it shows the standings only to a visitor who could open the board
// anyway: with PROTECT_DISPLAY on, the leaders appear after sign-in.

import { Hono } from "hono";
import { isProtected, protectedPrefixes, signedIn } from "../auth.ts";
import { activeEvent } from "../data.ts";
import { homePage } from "../views/home.ts";
import { boardData } from "./display.ts";

export const home = new Hono<{ Bindings: Env }>();

const PATHS = ["/display", "/entry", "/results", "/admin"];

home.get("/", async (c) => {
  const prefixes = protectedPrefixes(c.env);
  const gated = PATHS.filter((p) => isProtected(p, prefixes));
  const locked = gated.length > 0 && (await signedIn(c)) ? [] : gated;

  const event = await activeEvent(c.env.DB);
  const board = event ? await boardData(c.env.DB, event.event_id) : null;
  if (!event || !board) {
    return c.html(homePage({ event: null, gamesRecorded: 0, players: 0, leaders: null, prizesClaimed: 0, prizesTotal: 0, locked }));
  }

  const showBoard = !locked.includes("/display");
  const played = board.standings.filter(([, s]) => s.games_played > 0);
  return c.html(
    homePage({
      event,
      gamesRecorded: board.gamesRecorded,
      players: board.standings.length,
      leaders: showBoard
        ? played.filter(([rank]) => rank <= 3).map(([rank, s]) => ({ rank, player: s.player, points: s.win_points }))
        : null,
      prizesClaimed: board.prizes.filter((p) => p.winner !== null).length,
      prizesTotal: board.prizes.length,
      locked,
    }),
  );
});
