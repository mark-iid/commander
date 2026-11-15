// Tracker data-entry surface.
//
// One screen per (pod, match). The table is seated first, because seating
// rotates every match and is therefore data rather than an inference, and from
// then on the screen has two jobs, matching the two halves of the event
// owner's tracking sheet:
//
//   POST /entry/turn          one player's one turn cycle, saved live
//   POST /entry/final         the "Entered at Player Death or Win" section
//   POST /entry/eliminations  the same section for everybody a turn put out
//
// Splitting them is what lets a turn be recorded before anyone knows the
// finishing order. The old single form demanded a placement on every save, so a
// tracker three turns into a game could not save at all.
//
// The rules it decides by are in worker/entry-rules.ts; this file is the
// plumbing around them.

import { Hono } from "hono";
import type { Context } from "hono";
import { activeEvent, pods as loadPods, roster, scoringConfig, statsForGame } from "../data.ts";
import {
  commandersForMatch,
  findGame,
  getOrCreateGame,
  playerIds,
  players,
  roundsPlayed,
  saveFinals,
  saveMatchCommanders,
  saveTurn,
  seatPlayers,
  seatedElsewhere,
  turnGrid,
} from "../entry-data.ts";
import {
  MAX_ROUNDS,
  eliminationPrompt,
  enteredKey,
  expectedPodSize,
  finishingOrder,
  nextUp,
  ordinal,
  placementLabel,
  seatAfter,
} from "../entry-rules.ts";
import {
  type Errors,
  STALE_TABLE_MESSAGE,
  StaleTable,
  parseFinal,
  parseFinalValues,
  parseTurn,
} from "../entry-validate.ts";
import { COMMANDER_MAX, TURN_FIELDS } from "../fields.ts";
import { type ElimEcho, type EntryContext, draftStatus, entryPage, panel } from "../views/entry.ts";
import { statsChanged } from "../events.ts";

export const entry = new Hono<{ Bindings: Env }>();

/** The death/win form's own inputs. Its section opens only when one errors. */
const FINAL_FIELDS = ["placement", "final_life", "total_graveyard"];

function asInt(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/**
 * Fall back to the first valid option rather than 404ing: the selectors are
 * driven by the same lists, so an out-of-range value means a stale tab.
 */
function resolveSelection(
  pod: string | null,
  matchNo: number | null,
  pods: string[],
  matches: number[],
): [string, number] {
  return [
    pod !== null && pods.includes(pod) ? pod : (pods[0] ?? ""),
    matchNo !== null && matches.includes(matchNo) ? matchNo : (matches[0] ?? 1),
  ];
}

interface ContextOptions {
  values?: Record<string, string | number>;
  errors?: Errors;
  elim?: ElimEcho | null;
  justCredited?: number;
  saved?: string;
}

async function buildContext(
  db: D1Database,
  selection: {
    pod: string | null;
    match_no: number | null;
    player: string | null;
    round_no: number | null;
  },
  options: ContextOptions = {},
): Promise<EntryContext | null> {
  const event = await activeEvent(db);
  if (!event) return null;
  const eventId = event.event_id;

  const [names, config, podLabels, roster_] = await Promise.all([
    roster(db, eventId),
    scoringConfig(db, eventId),
    loadPods(db, eventId),
    players(db, eventId),
  ]);

  const matches = Array.from({ length: event.games_per_player }, (_, i) => i + 1);
  const [pod, matchNo] = resolveSelection(selection.pod, selection.match_no, podLabels, matches);
  const placements = [...config.placement_points.keys()].sort((a, b) => a - b);
  const podSize = expectedPodSize(event.pod_size, placements);

  const gameId = await findGame(db, eventId, pod, matchNo);
  const [seating, played, grid, podStats] = gameId
    ? await Promise.all([
        (async () => {
          const { results } = await db
            .prepare(
              `SELECT p.name FROM game_seats s JOIN players p ON p.player_id = s.player_id
               WHERE s.game_id = ? ORDER BY s.seat`,
            )
            .bind(gameId)
            .all<{ name: string }>();
          return results.map((r) => r.name);
        })(),
        roundsPlayed(db, gameId),
        turnGrid(db, gameId),
        statsForGame(db, gameId),
      ])
    : [[] as string[], 0, new Map(), []];

  // Players with a placement, which is how a tracker records that they are out
  // (or won).
  const out = new Map<string, number>(
    podStats.filter((s) => s.placement !== null).map((s) => [s.player, s.placement!]),
  );

  let player = selection.player;
  let roundNo = selection.round_no;
  const validRound = roundNo !== null && roundNo >= 1 && roundNo <= MAX_ROUNDS;
  if (player === null || !seating.includes(player)) {
    // No player asked for (a fresh page, a pod or match switch), or one from a
    // stale tab who is not at this table: land on whoever is next up rather
    // than offer a form that is already saved or cannot be saved.
    const up = nextUp(seating, new Set(out.keys()), new Set(grid.keys()), played);
    player = up.player;
    if (!validRound) roundNo = up.round_no;
  } else if (!validRound) {
    // The table shares one round counter: default to the round in progress.
    roundNo = Math.max(played, 1);
  }
  const opponents = seating.filter((n) => n !== player);

  // The round control is a selector rather than a free number. It offers the
  // rounds this table has played plus the next one, which is every round a
  // tracker can legitimately be entering, and it makes the one slip that is
  // now expensive impossible: typing 1 for 11 lands on a round finished an
  // hour ago, and since each box keeps itself as it is left, merely leaving a
  // box there overwrites it. A round carried in on the URL is offered even
  // when it is past the end, so a stale link cannot be quietly retargeted.
  const offered = new Set(
    Array.from({ length: Math.min(played + 1, MAX_ROUNDS) }, (_, i) => i + 1),
  );
  if (roundNo) offered.add(roundNo);
  // Which rounds THIS player has already entered, for the tick in the round
  // picker. Read off the grid's keys rather than by a query per round.
  const thisPlayersRounds = new Set<number>();
  if (player !== null) {
    for (const t of grid.values()) {
      if (grid.has(enteredKey(player, t.round_no))) thisPlayersRounds.add(t.round_no);
    }
  }
  const roundOptions: [number, boolean][] = [...offered]
    .sort((a, b) => a - b)
    .map((r) => [r, thisPlayersRounds.has(r)]);

  const turn = player && roundNo ? (grid.get(enteredKey(player, roundNo)) ?? null) : null;
  const finalRow = player ? (podStats.find((s) => s.player === player) ?? null) : null;
  const final = finalRow ? { placement: finalRow.placement } : null;

  // The finishing order is the order players go out, so the place the next one
  // to go out takes is the count of players still in. A suggestion only:
  // simultaneous deaths and games on time are the tracker's call.
  const stillIn = seating.filter((n) => !out.has(n)).length;
  const suggested =
    player !== null && !out.has(player) && config.placement_points.has(stillIn)
      ? stillIn
      : null;

  let values = options.values;
  if (values === undefined) {
    // Prefill from what is recorded, so a re-save corrects the row instead of
    // blanking the fields the tracker did not retype.
    values = {};
    for (const f of TURN_FIELDS) {
      values[f.name] = turn ? ((turn as unknown as Record<string, number>)[f.name] ?? "") : "";
    }
    opponents.forEach((name, i) => {
      values![`dmg_${i + 1}`] = turn ? (turn.damage.get(name) ?? "") : "";
    });
    values["placement"] = finalRow?.placement ?? suggested ?? "";
    values["final_life"] = finalRow && finalRow.placement !== null ? finalRow.final_life : "";
    values["total_graveyard"] =
      finalRow && finalRow.placement !== null ? finalRow.total_graveyard : "";
  }

  // Everyone already dealt into another pod for this match. Seating the same
  // player twice in one match would give them two rows for one game and
  // quietly double their win points.
  const taken = await seatedElsewhere(db, eventId, matchNo, gameId);

  // The deck boxes for this table: what is recorded for this match, falling
  // back to the player's usual deck from the roster. The fallback is only a
  // pre-fill; until the form is saved nothing is recorded for the match, which
  // is what keeps "they brought their usual" and "nobody said" distinct on the
  // results sheet.
  const recorded = seating.length > 0 ? await commandersForMatch(db, eventId, matchNo) : new Map();
  const usual = new Map(roster_.filter((p) => p.commander).map((p) => [p.name, p.commander!]));
  const commanders = new Map(
    seating.map((name) => [name, recorded.get(name) || (usual.get(name) ?? "")]),
  );

  const errors = options.errors ?? {};
  const prompt = eliminationPrompt(
    seating,
    out,
    [...grid.values()].map((t) => t.opps_eliminated),
    config.placement_points,
    options.justCredited ?? 0,
  );

  return {
    event,
    pods: podLabels,
    matches,
    roster: names,
    pod,
    match_no: matchNo,
    player,
    round_no: roundNo ?? 1,
    round_options: roundOptions,
    rounds_played: played,
    seating,
    opponents,
    seatable: names.filter((n) => !taken.has(n)),
    commanders,
    placement_options: placements.map((p) => [
      p,
      placementLabel(p, config.placement_points.get(p)!),
    ]),
    pod_size: podSize,
    values,
    errors,
    turn,
    final,
    turn_grid: grid,
    pod_stats: podStats,
    out: new Map([...out].map(([name, place]) => [name, ordinal(place)])),
    entered: new Set(
      seating.filter((n) => roundNo !== null && grid.has(enteredKey(n, roundNo))),
    ),
    final_open: FINAL_FIELDS.some((f) => f in errors),
    elim: options.elim ?? null,
    saved: options.saved ?? "",
    ...prompt,
  };
}

/**
 * Render the panel, and put where the tracker now is into the address bar.
 *
 * Every save moves the tracker (next seat, next round), but htmx swaps leave
 * the URL alone, so a reload used to drop them back on pod A, match 1, seat 1.
 * Replace rather than push: a game is a hundred saves, and Back should leave
 * the page, not step through them.
 */
function panelResponse(
  c: Context<{ Bindings: Env }>,
  ctx: EntryContext,
  status: 200 | 422 = 200,
): Response | Promise<Response> {
  const params = new URLSearchParams({ pod: ctx.pod, match_no: String(ctx.match_no) });
  if (ctx.player) {
    params.set("player", ctx.player);
    params.set("round_no", String(ctx.round_no));
  }
  return c.html(panel(ctx), status, { "HX-Replace-Url": `/entry?${params}` });
}

async function formBody(c: Context): Promise<Record<string, string>> {
  const form = await c.req.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of form) out[k] = String(v);
  return out;
}

const NO_EVENT = "No event configured yet.";

entry.get("/", async (c) => {
  const url = new URL(c.req.url);
  const ctx = await buildContext(c.env.DB, {
    pod: url.searchParams.get("pod"),
    match_no: asInt(url.searchParams.get("match_no")),
    player: url.searchParams.get("player"),
    round_no: asInt(url.searchParams.get("round_no")),
  });
  if (!ctx) return c.text(NO_EVENT, 503);
  return c.html(entryPage(ctx));
});

entry.get("/form", async (c) => {
  const url = new URL(c.req.url);
  const ctx = await buildContext(c.env.DB, {
    pod: url.searchParams.get("pod"),
    match_no: asInt(url.searchParams.get("match_no")),
    player: url.searchParams.get("player"),
    round_no: asInt(url.searchParams.get("round_no")),
  });
  if (!ctx) return c.text(NO_EVENT, 503);
  return panelResponse(c, ctx);
});

/** Set who is at this table, in turn order. Creates the game if needed. */
entry.post("/seat", async (c) => {
  const form = await c.req.formData();
  // getAll, not a plain object: the seat inputs deliberately share one name, so
  // the browser sends `seat` once per seat and their order is the turn order.
  const raw = form.getAll("seat").map((v) => String(v));
  const pod = String(form.get("pod") ?? "");
  const matchNo = asInt(String(form.get("match_no") ?? ""));

  const event = await activeEvent(c.env.DB);
  if (!event) return c.text(NO_EVENT, 503);
  const eventId = event.event_id;
  const [names_, config, podLabels] = await Promise.all([
    roster(c.env.DB, eventId),
    scoringConfig(c.env.DB, eventId),
    loadPods(c.env.DB, eventId),
  ]);
  const matches = Array.from({ length: event.games_per_player }, (_, i) => i + 1);
  const podSize = expectedPodSize(
    event.pod_size,
    [...config.placement_points.keys()].sort((a, b) => a - b),
  );

  const names = raw.map((n) => n.trim()).filter((n) => n !== "");
  const errors: Errors = {};
  if (!podLabels.includes(pod)) errors["pod"] = `unknown pod '${pod}'`;
  if (matchNo === null || !matches.includes(matchNo)) {
    errors["match_no"] = `match must be 1-${event.games_per_player}`;
  }

  // Clearing frees this table's players for the other pod. Without it a swap
  // between pods deadlocks once all eight are dealt: each table refuses the
  // player the other one holds. Nothing recorded is deleted.
  if (form.get("clear") && Object.keys(errors).length === 0) {
    const gameId = await findGame(c.env.DB, eventId, pod, matchNo!);
    if (gameId !== null) {
      await seatPlayers(c.env.DB, gameId, []);
      await statsChanged(c);
    }
    const ctx = await buildContext(
      c.env.DB,
      { pod, match_no: matchNo, player: null, round_no: null },
      { saved: "Table cleared" },
    );
    return panelResponse(c, ctx!);
  }

  if (names.length !== podSize) {
    errors["seating"] = `a table seats ${podSize} — ${names.length} chosen`;
  }
  if (new Set(names).size !== names.length) errors["seating"] = "the same player twice";
  if (names.some((n) => !names_.includes(n))) {
    errors["seating"] = "somebody here is not on the roster";
  }

  if (Object.keys(errors).length === 0) {
    const gameId = await getOrCreateGame(c.env.DB, eventId, pod, matchNo!);
    const elsewhere = await seatedElsewhere(c.env.DB, eventId, matchNo!, gameId);
    const clash = names.filter((n) => elsewhere.has(n));
    if (clash.length > 0) {
      errors["seating"] =
        `already seated at another pod this match: ${[...clash].sort().join(", ")}`;
    } else {
      const ids = await playerIds(c.env.DB, eventId);
      await seatPlayers(
        c.env.DB,
        gameId,
        names.map((n) => ids.get(n)!),
      );
      await statsChanged(c);
      const ctx = await buildContext(
        c.env.DB,
        { pod, match_no: matchNo, player: names[0]!, round_no: null },
        { saved: "Table set" },
      );
      return panelResponse(c, ctx!);
    }
  }

  const ctx = await buildContext(
    c.env.DB,
    { pod, match_no: matchNo, player: null, round_no: null },
    { errors },
  );
  return panelResponse(c, ctx!, 422);
});

/**
 * Record which deck each player at this table brought to this match.
 *
 * Paired lists, not `commander_<name>` keys: a name can contain anything a
 * roster allows, and building form keys out of it would need escaping that the
 * template and the parser would have to agree on forever. The browser sends
 * both lists in document order, so player[i] names the player commander[i]
 * belongs to.
 *
 * Only players actually seated here are written. A stale tab naming somebody
 * who has since moved to the other pod would otherwise record a deck against
 * them from a table they are not at.
 */
entry.post("/commanders", async (c) => {
  const form = await c.req.formData();
  const names = form.getAll("player").map((v) => String(v));
  const decks = form.getAll("commander").map((v) => String(v));
  const pod = String(form.get("pod") ?? "");
  const matchNo = asInt(String(form.get("match_no") ?? ""));

  const event = await activeEvent(c.env.DB);
  if (!event) return c.text(NO_EVENT, 503);
  const eventId = event.event_id;
  const podLabels = await loadPods(c.env.DB, eventId);
  const matches = Array.from({ length: event.games_per_player }, (_, i) => i + 1);

  const errors: Errors = {};
  if (!podLabels.includes(pod)) errors["pod"] = `unknown pod '${pod}'`;
  if (matchNo === null || !matches.includes(matchNo)) {
    errors["match_no"] = `match must be 1-${event.games_per_player}`;
  }
  if (names.length !== decks.length) {
    // Only reachable from a hand-built POST; a browser sends one of each per
    // row. Refused rather than zipped short, because zipping would silently
    // drop the tail and report success for decks it never saved.
    errors["commanders"] = "the form was sent incomplete: open the table again";
  }

  const gameId =
    Object.keys(errors).length === 0 ? await findGame(c.env.DB, eventId, pod, matchNo!) : null;
  const seating = gameId
    ? (
        await c.env.DB.prepare(
          `SELECT p.name FROM game_seats s JOIN players p ON p.player_id = s.player_id
           WHERE s.game_id = ? ORDER BY s.seat`,
        )
          .bind(gameId)
          .all<{ name: string }>()
      ).results.map((r) => r.name)
    : [];

  const submitted = new Map<string, string>();
  names.forEach((name, i) => {
    if (seating.includes(name)) submitted.set(name, decks[i] ?? "");
  });

  if (
    Object.keys(errors).length === 0 &&
    [...submitted.values()].some((d) => d.trim().length > COMMANDER_MAX)
  ) {
    // maxlength= on the input is a client-side hint; an unbounded deck name
    // reaches the results sheet.
    errors["commanders"] = `a commander must be ${COMMANDER_MAX} characters or fewer`;
  }

  if (Object.keys(errors).length > 0) {
    const ctx = await buildContext(
      c.env.DB,
      { pod, match_no: matchNo, player: null, round_no: null },
      { errors },
    );
    return panelResponse(c, ctx!, 422);
  }

  if (submitted.size === 0) {
    // Nobody named is at this table: a stale tab, or a table cleared since the
    // form was drawn. Re-render rather than report a save that did not happen;
    // the banner is the only proof the tracker gets.
    const ctx = await buildContext(c.env.DB, {
      pod,
      match_no: matchNo,
      player: null,
      round_no: null,
    });
    return panelResponse(c, ctx!);
  }

  const ids = await playerIds(c.env.DB, eventId);
  await saveMatchCommanders(
    c.env.DB,
    eventId,
    matchNo!,
    new Map([...submitted].map(([name, deck]) => [ids.get(name)!, deck])),
  );
  // The results sheet renders the decks, so the display has to know.
  await statsChanged(c);

  const ctx = await buildContext(
    c.env.DB,
    { pod, match_no: matchNo, player: null, round_no: null },
    { saved: "Commanders saved" },
  );
  return panelResponse(c, ctx!);
});

/** The seating of one table, by name, in turn order. */
async function seatingOf(db: D1Database, gameId: number | null): Promise<string[]> {
  if (gameId === null) return [];
  const { results } = await db
    .prepare(
      `SELECT p.name FROM game_seats s JOIN players p ON p.player_id = s.player_id
       WHERE s.game_id = ? ORDER BY s.seat`,
    )
    .bind(gameId)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

async function turnContext(
  c: Context<{ Bindings: Env }>,
  submitted: Record<string, string>,
): Promise<{ pods: string[]; matches: number[]; seating: string[]; gameId: number | null } | null> {
  const event = await activeEvent(c.env.DB);
  if (!event) return null;
  const [podLabels] = await Promise.all([loadPods(c.env.DB, event.event_id)]);
  const matches = Array.from({ length: event.games_per_player }, (_, i) => i + 1);
  const matchNo = asInt(submitted["match_no"]);
  const gameId =
    matchNo !== null && podLabels.includes(submitted["pod"] ?? "")
      ? await findGame(c.env.DB, event.event_id, submitted["pod"]!, matchNo)
      : null;
  return { pods: podLabels, matches, seating: await seatingOf(c.env.DB, gameId), gameId };
}

entry.post("/turn", async (c) => {
  const submitted = await formBody(c);
  const ctxData = await turnContext(c, submitted);
  if (!ctxData) return c.text(NO_EVENT, 503);

  const selection = {
    pod: submitted["pod"] ?? null,
    match_no: asInt(submitted["match_no"]),
    player: submitted["player"] ?? null,
    round_no: asInt(submitted["round_no"]),
  };

  let parsed;
  try {
    parsed = parseTurn(submitted, ctxData, { crossChecks: true });
  } catch (e) {
    if (!(e instanceof StaleTable)) throw e;
    // Redrawn without the stale numbers, rather than saved against whoever
    // sits in those seats now.
    const ctx = await buildContext(c.env.DB, selection, {
      errors: { player: STALE_TABLE_MESSAGE },
    });
    return panelResponse(c, ctx!, 422);
  }

  if (parsed.entry === null || Object.keys(parsed.errors).length > 0 || ctxData.gameId === null) {
    const ctx = await buildContext(c.env.DB, selection, {
      values: submitted,
      errors:
        Object.keys(parsed.errors).length > 0
          ? parsed.errors
          : { player: "that table has not been set yet" },
    });
    return panelResponse(c, ctx!, 422);
  }

  const event = (await activeEvent(c.env.DB))!;
  const ids = await playerIds(c.env.DB, event.event_id);
  await saveTurn(
    c.env.DB,
    ctxData.gameId,
    ids.get(parsed.entry.player)!,
    { ...parsed.entry, damage: parsed.damage },
    ids,
  );
  await statsChanged(c);

  // Advance to the next seat still in the game, so a tracker walking the table
  // taps Save and lands on whoever plays next instead of reselecting.
  const podStats = await statsForGame(c.env.DB, ctxData.gameId);
  const out = new Set(podStats.filter((s) => s.placement !== null).map((s) => s.player));
  const next = seatAfter(ctxData.seating, out, parsed.entry.player, parsed.entry.round_no);

  const ctx = await buildContext(
    c.env.DB,
    {
      pod: parsed.entry.pod,
      match_no: parsed.entry.match_no,
      player: next.player,
      round_no: next.round_no,
    },
    {
      // Guarantees the rows at the moment the kill is entered, whatever the
      // derived count makes of it afterwards.
      justCredited: parsed.entry.opps_eliminated,
      saved: `Round ${parsed.entry.round_no} saved for ${parsed.entry.player}`,
    },
  );
  return panelResponse(c, ctx!);
});

/**
 * Keep what has been typed into the turn form, without moving anything.
 *
 * Every numeric box posts here as it is left, so a tracker four boxes into a
 * turn who has to jump to another player, to record the death that player's
 * attack just caused, comes back to find those four numbers still in it.
 *
 * It writes the same turn_stats row the Save button writes, through the same
 * upsert, so Save then rewrites it rather than adding a second one. And it
 * deliberately does nothing else: no advance to the next seat, no banner, no
 * panel swap. A redraw mid-entry moves the box being typed in, which is its own
 * way of losing what is in it.
 *
 * It does not broadcast either. The display would otherwise push half-typed
 * numbers to the projector a box at a time; the Save button that finishes the
 * turn is a second away and broadcasts then.
 *
 * Always 200, even when it could not keep the numbers: htmx processes an
 * out-of-band swap only from a response it would swap at all, and a 4xx here
 * would trip the "Not saved" banner meant for a lost connection, on a form the
 * tracker is still halfway through typing.
 */
entry.post("/turn/draft", async (c) => {
  const submitted = await formBody(c);
  const player = (submitted["player"] ?? "").trim();
  const roundNo = (submitted["round_no"] ?? "").trim();
  // Named, not just "Saved": this line is swapped in out of band, so it can
  // land on a panel the tracker has already moved on from.
  const where = player && roundNo ? `${player} round ${roundNo}` : "that turn";

  const ctxData = await turnContext(c, submitted);
  if (!ctxData) return c.html(draftStatus(`${where} not kept: no event`, true, true));

  let parsed;
  try {
    parsed = parseTurn(submitted, ctxData, { crossChecks: false });
  } catch (e) {
    if (!(e instanceof StaleTable)) throw e;
    return c.html(draftStatus(`Not kept — ${STALE_TABLE_MESSAGE}`, true, true));
  }

  if (parsed.entry === null || Object.keys(parsed.errors).length > 0 || ctxData.gameId === null) {
    const why = Object.values(parsed.errors)[0] ?? "the form was sent incomplete";
    return c.html(draftStatus(`${where} not kept: ${why}`, true, true));
  }

  const event = (await activeEvent(c.env.DB))!;
  const ids = await playerIds(c.env.DB, event.event_id);
  await saveTurn(
    c.env.DB,
    ctxData.gameId,
    ids.get(parsed.entry.player)!,
    { ...parsed.entry, damage: parsed.damage },
    ids,
  );
  return c.html(draftStatus(`Kept ${where}`, false, true));
});

entry.post("/final", async (c) => {
  const submitted = await formBody(c);
  const event = await activeEvent(c.env.DB);
  if (!event) return c.text(NO_EVENT, 503);
  const eventId = event.event_id;

  const [podLabels, config] = await Promise.all([
    loadPods(c.env.DB, eventId),
    scoringConfig(c.env.DB, eventId),
  ]);
  const matches = Array.from({ length: event.games_per_player }, (_, i) => i + 1);
  const matchNo = asInt(submitted["match_no"]);
  const gameId =
    matchNo !== null && podLabels.includes(submitted["pod"] ?? "")
      ? await findGame(c.env.DB, eventId, submitted["pod"]!, matchNo)
      : null;
  const seating = await seatingOf(c.env.DB, gameId);
  const placements = [...config.placement_points.keys()].sort((a, b) => a - b);

  const { entry: parsed, errors } = parseFinal(submitted, {
    pods: podLabels,
    matches,
    seating,
    placements,
  });

  const selection = {
    pod: submitted["pod"] ?? null,
    match_no: matchNo,
    player: submitted["player"] ?? null,
    round_no: asInt(submitted["round_no"]),
  };

  if (parsed === null || Object.keys(errors).length > 0 || gameId === null) {
    const ctx = await buildContext(c.env.DB, selection, {
      values: submitted,
      errors:
        Object.keys(errors).length > 0
          ? errors
          : { player: "that table has not been set yet" },
    });
    return panelResponse(c, ctx!, 422);
  }

  const ids = await playerIds(c.env.DB, eventId);
  await saveFinals(
    c.env.DB,
    gameId,
    new Map([
      [
        ids.get(parsed.player)!,
        {
          placement: parsed.placement,
          final_life: parsed.final_life,
          total_graveyard: parsed.total_graveyard,
        },
      ],
    ]),
  );
  await statsChanged(c);

  const ctx =
    parsed.placement === null
      ? // A correction to someone still playing: stay on them.
        await buildContext(
          c.env.DB,
          { ...selection, player: parsed.player },
          { saved: `${parsed.player} updated` },
        )
      : // A death is usually recorded in the middle of somebody else's turn.
        // Go back to the game rather than leave the tracker on a player who
        // will not take another one.
        await buildContext(
          c.env.DB,
          { pod: parsed.pod, match_no: parsed.match_no, player: null, round_no: null },
          { saved: `${parsed.player} finished ${ordinal(parsed.placement)}` },
        );
  return panelResponse(c, ctx!);
});

/**
 * Record everybody a turn put out, in one submit.
 *
 * Parallel lists, like the decks form and for the same reason: a row is a
 * select and two boxes, and the browser sends all three per row in document
 * order, so player[i] owns final_life[i] and total_graveyard[i]. A row with
 * nobody picked is skipped: a tracker offered two rows because two kills were
 * credited may only know one of the deaths yet.
 *
 * Placements are derived, not asked for. The rows are in the order the players
 * went out, so the numbers follow from how many were still playing.
 */
entry.post("/eliminations", async (c) => {
  const form = await c.req.formData();
  const pod = String(form.get("pod") ?? "");
  const matchNo = asInt(String(form.get("match_no") ?? ""));
  const roundNo = asInt(String(form.get("round_no") ?? ""));
  const names = form.getAll("player").map((v) => String(v).trim());
  const lives = form.getAll("final_life").map((v) => String(v));
  const yards = form.getAll("total_graveyard").map((v) => String(v));
  const simultaneous = Boolean(form.get("simultaneous"));
  const winner = String(form.get("winner") ?? "").trim();

  const event = await activeEvent(c.env.DB);
  if (!event) return c.text(NO_EVENT, 503);
  const eventId = event.event_id;
  const [podLabels, config] = await Promise.all([
    loadPods(c.env.DB, eventId),
    scoringConfig(c.env.DB, eventId),
  ]);
  const matches = Array.from({ length: event.games_per_player }, (_, i) => i + 1);

  // Handed back to the form if this is refused, so the tracker's numbers are
  // still in the boxes. Nine boxes is too many to retype over one bad digit.
  const elim: ElimEcho = {
    rows: names.map((n, i) => ({
      player: n,
      final_life: lives[i] ?? "",
      total_graveyard: yards[i] ?? "",
    })),
    winner: {
      player: winner,
      final_life: String(form.get("winner_life") ?? ""),
      total_graveyard: String(form.get("winner_graveyard") ?? ""),
    },
    simultaneous,
  };

  const errors: Errors = {};
  if (!podLabels.includes(pod)) errors["pod"] = `unknown pod '${pod}'`;
  if (matchNo === null || !matches.includes(matchNo)) {
    errors["match_no"] = `match must be 1-${event.games_per_player}`;
  }
  if (!(names.length === lives.length && lives.length === yards.length)) {
    // Only reachable from a hand-built POST; the form sends all three per row.
    // Refused rather than zipped short, which would file a death against
    // somebody else's life total.
    errors["eliminations"] = "the form was sent incomplete: open the table again";
  }

  const refuse = async () => {
    const ctx = await buildContext(
      c.env.DB,
      { pod, match_no: matchNo, player: null, round_no: roundNo },
      { errors, elim },
    );
    return panelResponse(c, ctx!, 422);
  };

  if (Object.keys(errors).length > 0) return await refuse();

  const gameId = await findGame(c.env.DB, eventId, pod, matchNo!);
  const seating = await seatingOf(c.env.DB, gameId);
  const podStats = gameId ? await statsForGame(c.env.DB, gameId) : [];
  const out = new Map(
    podStats.filter((s) => s.placement !== null).map((s) => [s.player, s.placement!]),
  );
  const stillIn = seating.filter((n) => !out.has(n)).length;

  const submitted = names
    .map((n, i) => ({ name: n, life: lives[i] ?? "", yard: yards[i] ?? "" }))
    .filter((r) => r.name !== "");

  const seen = new Set<string>();
  for (const { name } of submitted) {
    if (!seating.includes(name)) {
      errors["eliminations"] = `'${name}' is not at this table`;
    } else if (out.has(name)) {
      // Rewriting a recorded placement from here would renumber the finishing
      // order around a death already inside it.
      errors["eliminations"] =
        `${name} is already recorded out — correct them in their own section`;
    } else if (seen.has(name)) {
      errors["eliminations"] = `${name} is listed twice`;
    }
    seen.add(name);
  }

  if (winner && Object.keys(errors).length === 0) {
    if (!seating.includes(winner)) errors["eliminations"] = `'${winner}' is not at this table`;
    else if (out.has(winner)) errors["eliminations"] = `${winner} is already recorded out`;
    else if (seen.has(winner)) errors["eliminations"] = `${winner} cannot both go out and win`;
  }

  if (Object.keys(errors).length === 0 && submitted.length > 0 && submitted.length >= stillIn) {
    // Everybody still playing, listed as going out. The derived placements
    // would run all the way down to the best one and hand it to a player who
    // is dead: the app inventing a winner for a game that had none.
    errors["eliminations"] =
      "that would leave nobody standing: a game that ended without a " +
      "winner goes in on each player's own form";
  }

  const parsed: { name: string; final_life: number; total_graveyard: number }[] = [];
  submitted.forEach((row, i) => {
    const values = parseFinalValues(
      { final_life: row.life, total_graveyard: row.yard },
      { final_life: `elim_life_${i}`, total_graveyard: `elim_yard_${i}` },
      errors,
    );
    if (values) parsed.push({ name: row.name, ...values });
  });

  let winnerValues: { final_life: number; total_graveyard: number } | null = null;
  if (winner) {
    winnerValues = parseFinalValues(
      {
        final_life: elim.winner.final_life,
        total_graveyard: elim.winner.total_graveyard,
      },
      { final_life: "winner_life", total_graveyard: "winner_graveyard" },
      errors,
    );
  }

  let places = new Map<string, number>();
  if (Object.keys(errors).length === 0 && parsed.length > 0) {
    places = finishingOrder(
      parsed.map((p) => [p.name, p.final_life]),
      stillIn,
      simultaneous,
    );
    const unscored = [...new Set(places.values())]
      .filter((p) => !config.placement_points.has(p))
      .sort((a, b) => a - b);
    if (unscored.length > 0) {
      // More players going out than there are places left to finish in: a
      // stale form, or a row filled in for somebody already counted.
      errors["eliminations"] =
        `that would finish somebody ${ordinal(unscored[0]!)}, ` +
        "which this event does not score";
    }
  }

  if (Object.keys(errors).length > 0) return await refuse();

  if (parsed.length === 0 && winnerValues === null) {
    // Every row left blank. Re-render rather than report a save that did not
    // happen; the banner is the only proof the tracker gets.
    const ctx = await buildContext(c.env.DB, {
      pod,
      match_no: matchNo,
      player: null,
      round_no: roundNo,
    });
    return panelResponse(c, ctx!);
  }

  const placements = [...config.placement_points.keys()];
  const best = placements.length > 0 ? Math.min(...placements) : 1;
  const ids = await playerIds(c.env.DB, eventId);
  const finals = new Map(
    parsed.map((p) => [
      ids.get(p.name)!,
      {
        placement: places.get(p.name)!,
        final_life: p.final_life,
        total_graveyard: p.total_graveyard,
      },
    ]),
  );
  const told: { name: string; placement: number }[] = parsed.map((p) => ({
    name: p.name,
    placement: places.get(p.name)!,
  }));
  if (winnerValues !== null) {
    finals.set(ids.get(winner)!, { placement: best, ...winnerValues });
    told.push({ name: winner, placement: best });
  }

  // One batch: the placements are one fact about the finishing order, and half
  // of them written is an order no table played.
  await saveFinals(c.env.DB, gameId!, finals);
  await statsChanged(c);

  const message = told
    // Worst placement first, which is the order they went out in.
    .sort((a, b) => b.placement - a.placement)
    .map((t) => (t.placement === best ? `${t.name} won` : `${t.name} finished ${ordinal(t.placement)}`))
    .join(", ");

  // Back to the table rather than onto a player who will not take another
  // turn, the same as a death saved on its own.
  const ctx = await buildContext(
    c.env.DB,
    { pod, match_no: matchNo, player: null, round_no: null },
    { saved: message },
  );
  return panelResponse(c, ctx!);
});
