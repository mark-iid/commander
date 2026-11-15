// The results sheet and the two exports.
//
//   GET /results            a page laid out for paper as much as for screen
//   GET /results.csv        the per-player-per-game rows, for a spreadsheet
//   GET /results/turns.csv  every individual turn, damage broken out per
//                           opponent: the event owner's own tracking sheet,
//                           filled in
//
// All three describe whatever has been recorded so far rather than waiting for
// a complete event, so the same URL is a mid-event snapshot after round one and
// the final results after round three. The header says which it is; a sheet
// that cannot tell you how much of the night it covers is worse than no sheet.
//
// Always behind the passcode, unlike the projected board: the CSV carries
// per-game rows for named people, which is a step past the standings a room can
// already see. Both /results and /results.csv are listed in protectedPrefixes
// because the matcher respects segment boundaries.

import { Hono } from "hono";
import {
  buildStandings,
  rankedStandings,
  resolvePrize,
  type GamePlayerStat,
} from "../../shared/scoring.ts";
import { csvResponse, generatedAt, slug, stamp, toCsv } from "../csv.ts";
import {
  activeEvent,
  allMatchCommanders,
  allSeating,
  allStats,
  allTurns,
  damageMatrix,
  deckKey,
  games,
  roster,
  scoringConfig,
} from "../data.ts";
import { GAME_STAT_FIELDS, TURN_FIELDS } from "../fields.ts";
import { type Matrix, type ResultsData, type Section, resultsPage } from "../views/results.ts";

export const results = new Hono<{ Bindings: Env }>();

const stat = (s: GamePlayerStat, name: string): number =>
  (s as unknown as Record<string, number>)[name] ?? 0;

/**
 * Per game: a dealer x target grid with both margins.
 *
 * The one view that only exists because damage is stored per opponent. Row
 * totals are what a player dealt, column totals what they took, so the
 * archenemy of a match is the tallest column, which no per-game scalar could
 * ever have told you.
 */
function buildMatrix(
  players: string[],
  pairs: Map<string, Map<string, number>> | undefined,
): Matrix {
  const cell = new Map<string, Map<string, number>>();
  for (const dealer of players) {
    const row = new Map<string, number>();
    for (const target of players) {
      if (target !== dealer) row.set(target, pairs?.get(dealer)?.get(target) ?? 0);
    }
    cell.set(dealer, row);
  }
  const dealt = new Map(
    players.map((d) => [d, [...(cell.get(d)?.values() ?? [])].reduce((a, b) => a + b, 0)]),
  );
  const taken = new Map(
    players.map((t) => [
      t,
      players.reduce((n, d) => n + (d === t ? 0 : (cell.get(d)?.get(t) ?? 0)), 0),
    ]),
  );
  return { players, cell, dealt, taken, any: (pairs?.size ?? 0) > 0 };
}

async function resultsData(db: D1Database, event: Awaited<ReturnType<typeof activeEvent>>) {
  const eventId = event!.event_id;
  const [names, config, stats, gameRows, seats, matrices, decks] = await Promise.all([
    roster(db, eventId),
    scoringConfig(db, eventId),
    allStats(db, eventId),
    games(db, eventId),
    allSeating(db, eventId),
    damageMatrix(db, eventId),
    allMatchCommanders(db, eventId),
  ]);
  return { eventId, names, config, stats, gameRows, seats, matrices, decks };
}

results.get("/results", async (c) => {
  const event = await activeEvent(c.env.DB);
  if (!event) return c.text("No event configured yet.", 503);
  const { names, config, stats, gameRows, seats, matrices, decks } = await resultsData(
    c.env.DB,
    event,
  );

  const standings = buildStandings(stats, config, names);
  const byId = new Map(gameRows.map((g) => [g.game_id, g]));

  // Grouped into the games they were played in, so the sheet can show the
  // night as it happened rather than only its totals.
  const byGame = new Map<number, GamePlayerStat[]>();
  for (const s of stats) {
    if (!byId.has(s.game_id)) continue;
    byGame.set(s.game_id, [...(byGame.get(s.game_id) ?? []), s]);
  }

  const sections: Section[] = [...byGame.entries()]
    .map(([gameId, rows]) => {
      const game = byId.get(gameId)!;
      return {
        match_no: game.match_no,
        pod: game.pod,
        // Unfinished players sort last: placement is null until they are out.
        rows: [...rows].sort(
          (a, b) =>
            Number(a.placement === null) - Number(b.placement === null) ||
            (a.placement ?? 0) - (b.placement ?? 0),
        ),
        matrix: buildMatrix(seats.get(gameId) ?? [], matrices.get(gameId)),
        commanders: new Map(
          rows.map((s) => [s.player, decks.get(deckKey(s.player, game.match_no)) ?? ""]),
        ),
      };
    })
    .sort((a, b) => a.match_no - b.match_no || a.pod.localeCompare(b.pod));

  const played = standings.filter((s) => s.games_played > 0);
  const expected = names.length * event.games_per_player;
  // Only FINISHED games count toward completeness. Every seated player has a
  // derived row from the moment their table is set, so counting rows would
  // call a match complete before a card had been played, and "Final" is the
  // one claim on this sheet that must never be ahead of the truth.
  const finished = stats.filter((s) => s.placement !== null);

  const data: ResultsData = {
    event,
    generated: generatedAt(new Date(), c.env.EVENT_TIMEZONE),
    standings: rankedStandings(standings),
    prizes: config.prizes.map((p) => resolvePrize(p, standings, config.prize_ineligible)),
    sections,
    rowsRecorded: finished.length,
    rowsExpected: expected,
    complete:
      names.length > 0 && finished.length >= expected && played.length === names.length,
    playersStarted: played.length,
    rosterSize: names.length,
  };
  return c.html(resultsPage(data));
});

function exportName(event: { name: string }, kind: string, tz: string): string {
  return `${slug(event.name)}-${kind}-${stamp(new Date(), tz)}.csv`;
}

// match, pod and the two fields every row has, then each derived stat.
//
// `commander` is the deck that player brought to that match, which is why it
// belongs on a per-game row and not on the standings: a player may bring a
// different one to each match, and their stats are summed across all of them
// regardless, because commander damage travels with the person.
const CSV_HEADER = [
  "match",
  "pod",
  "player",
  "commander",
  "placement",
  "final_life",
  ...GAME_STAT_FIELDS.map((f) => f.name),
];

results.get("/results.csv", async (c) => {
  const event = await activeEvent(c.env.DB);
  if (!event) return c.text("No event configured yet.", 503);
  const eventId = event.event_id;
  const [stats, gameRows, decks] = await Promise.all([
    allStats(c.env.DB, eventId),
    games(c.env.DB, eventId),
    allMatchCommanders(c.env.DB, eventId),
  ]);
  const byId = new Map(gameRows.map((g) => [g.game_id, g]));

  const rows = stats
    .filter((s) => byId.has(s.game_id))
    .map((s) => {
      const game = byId.get(s.game_id)!;
      return [
        game.match_no,
        game.pod,
        s.player,
        decks.get(deckKey(s.player, game.match_no)) ?? "",
        s.placement,
        s.final_life,
        ...GAME_STAT_FIELDS.map((f) => stat(s, f.name)),
      ];
    })
    // Sorted so two exports of the same data are byte-identical and diffable,
    // rather than however storage happened to return them.
    .sort(
      (a, b) =>
        (a[0] as number) - (b[0] as number) ||
        String(a[1]).localeCompare(String(b[1])) ||
        Number(a[4] === null) - Number(b[4] === null) ||
        ((a[4] as number) ?? 0) - ((b[4] as number) ?? 0),
    );

  return csvResponse(
    toCsv([CSV_HEADER, ...rows]),
    exportName(event, "results", c.env.EVENT_TIMEZONE),
  );
});

results.get("/results/turns.csv", async (c) => {
  // Shaped after the event owner's own tracking sheet: a damage column per
  // rostered player, because that is what makes the file readable in a
  // spreadsheet without a pivot. A cell is blank when that player was not at
  // the table for the match, and 0 when they were and took nothing, which is a
  // distinction a single zero would lose.
  const event = await activeEvent(c.env.DB);
  if (!event) return c.text("No event configured yet.", 503);
  const eventId = event.event_id;
  const [turns, gameRows, names, seats] = await Promise.all([
    allTurns(c.env.DB, eventId),
    games(c.env.DB, eventId),
    roster(c.env.DB, eventId),
    allSeating(c.env.DB, eventId),
  ]);
  const byId = new Map(gameRows.map((g) => [g.game_id, g]));
  const atTable = new Map([...seats].map(([gid, players]) => [gid, new Set(players)]));

  const header = [
    "match",
    "pod",
    "player",
    "round",
    ...names.map((n) => `dmg_to_${n}`),
    "round_combat_total",
    ...TURN_FIELDS.map((f) => f.name),
  ];

  const rows = turns
    .filter((t) => byId.has(t.game_id))
    .map((t) => {
      const game = byId.get(t.game_id)!;
      const seated = atTable.get(t.game_id) ?? new Set<string>();
      const damage = names.map((name) =>
        !seated.has(name) || name === t.player ? "" : (t.damage.get(name) ?? 0),
      );
      const total = [...t.damage.values()].reduce((a, b) => a + b, 0);
      return [
        game.match_no,
        game.pod,
        t.player,
        t.round_no,
        ...damage,
        total,
        ...TURN_FIELDS.map((f) => (t as unknown as Record<string, number>)[f.name] ?? 0),
      ];
    })
    .sort(
      (a, b) =>
        (a[0] as number) - (b[0] as number) ||
        String(a[1]).localeCompare(String(b[1])) ||
        (a[3] as number) - (b[3] as number) ||
        String(a[2]).localeCompare(String(b[2])),
    );

  return csvResponse(
    toCsv([header, ...rows]),
    exportName(event, "turns", c.env.EVENT_TIMEZONE),
  );
});
