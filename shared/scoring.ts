// Scoring engine: standings and prize winners from per-game stats plus config.
// Pure functions, no I/O, no framework imports, so it runs the same in a test,
// in a Worker and in a script.
//
// Held to a recorded event in shared/scoring.golden.test.ts: the standings,
// the board order and all eleven prize winners must come out unchanged.
//
// Field names are snake_case throughout, which is not an accident and not a
// style slip. Config refers to these fields BY NAME as strings -- a prize says
// `metric: combat_dmg_dealt`, a tiebreak says `field: win_points` -- so the
// property names are part of the config format. Renaming them to camelCase
// would break every existing event configuration, and silently: an unknown
// metric reads as zero rather than raising.

// --- Inputs -----------------------------------------------------------------

/**
 * One player's whole game, as the scoring engine sees it.
 *
 * Not a stored row: the repository derives it by aggregating the turn tables
 * (sums for totals, maxima for peaks) and joining the death/win values. That
 * assembly is the only place the two granularities meet.
 *
 * `placement` is null until the player is out, and is read through
 * placement_points, so an unfinished game scores zero win points while its
 * damage still counts -- which is what keeps the projected board live mid-match.
 *
 * `played` is false for a player who is seated with nothing recorded yet. A row
 * is still derived for them so the pod table can list the whole table, but
 * sitting down is not playing and buildStandings does not count it as a game.
 */
export interface GamePlayerStat {
  game_id: number;
  player: string;
  placement: number | null;
  final_life: number;
  combat_dmg_dealt: number;
  noncombat_dmg_dealt: number;
  cmdr_dmg_dealt: number;
  opps_eliminated: number;
  biggest_attack_dealt: number;
  biggest_attack_taken: number;
  most_creatures_in_attack: number;
  total_graveyard: number;
  // Night totals that only tiebreaks read: what reached this player, and every
  // creature they declared as an attacker, summed over their turns.
  combat_dmg_taken: number;
  creatures_attacked_with: number;
  played: boolean;
}

export interface Tiebreak {
  field: string;
  direction: "max" | "min";
  // Same meaning as a prize's scope. "peak" is for fields that are a best
  // single moment already: summing each game's biggest attack across the night
  // ranks nothing anyone asked for.
  scope: "night" | "peak";
}

export interface Prize {
  key: string;
  name: string;
  metric: string; // a stat field, or "win_points"
  agg: "max" | "min";
  scope: "night" | "peak";
  tiebreak: Tiebreak | null;
}

export interface ScoringConfig {
  placement_points: Map<number, number>;
  total_damage_fields: string[];
  prizes: Prize[];
  // Players who play and score but take no prize: each prize goes to the next
  // in line instead. For the organiser who is also at a table.
  prize_ineligible: string[];
}

// --- Outputs ----------------------------------------------------------------

export interface PlayerStanding {
  player: string;
  win_points: number;
  total_damage: number;
  games_played: number;
  // summed stat fields across the player's games
  totals: Record<string, number>;
  // the player's single best (max) value per field across games
  peaks: Record<string, number>;
}

export interface PrizeResult {
  key: string;
  name: string;
  winner: string | null;
  value: number | null;
}

/** One player's line in a prize's full ranking. */
export interface PrizeRankRow {
  rank: number;
  player: string;
  value: number;
  // The prize's tiebreak field for this player, or null if the prize has none.
  tiebreak: number | null;
  eligible: boolean;
}

export const SUMMABLE = [
  "combat_dmg_dealt",
  "noncombat_dmg_dealt",
  "cmdr_dmg_dealt",
  "opps_eliminated",
  "biggest_attack_dealt",
  "biggest_attack_taken",
  "most_creatures_in_attack",
  "total_graveyard",
  "combat_dmg_taken",
  "creatures_attacked_with",
] as const;

// Every field a prize or tiebreak may legitimately name. Nothing reads this at
// runtime -- an unknown name is deliberately zero, not an error, because the
// engine is generic -- but a test asserts the configured prizes stay inside it,
// which is the only thing standing between a typo and a prize that quietly
// never awards.
export const KNOWN_FIELDS: readonly string[] = ["total_damage", "win_points", ...SUMMABLE];

const STAT_DEFAULTS = {
  final_life: 0,
  combat_dmg_dealt: 0,
  noncombat_dmg_dealt: 0,
  cmdr_dmg_dealt: 0,
  opps_eliminated: 0,
  biggest_attack_dealt: 0,
  biggest_attack_taken: 0,
  most_creatures_in_attack: 0,
  total_graveyard: 0,
  combat_dmg_taken: 0,
  creatures_attacked_with: 0,
  played: true,
} as const;

/** A stat row with every unnamed field defaulted. */
export function gamePlayerStat(
  fields: Pick<GamePlayerStat, "game_id" | "player" | "placement"> & Partial<GamePlayerStat>,
): GamePlayerStat {
  return { ...STAT_DEFAULTS, ...fields };
}

/**
 * Read a named stat off a row, strictly.
 *
 * Only total_damage_fields comes through here, and a name that is not a numeric
 * stat is a broken config rather than a zero: this is the one list where a typo
 * must not be survivable, because it silently redefines the tiebreaker every
 * win-point prize rests on. Prize metrics and tiebreak fields take the lenient
 * path through totals/peaks instead, where an unknown name reads as zero.
 */
function statField(s: GamePlayerStat, name: string): number {
  const v = (s as unknown as Record<string, unknown>)[name];
  if (typeof v !== "number") {
    throw new Error(
      `total_damage_fields names "${name}", which is not a numeric stat on GamePlayerStat`,
    );
  }
  return v;
}

/**
 * One standing per rostered player, in roster order.
 *
 * Roster order is load-bearing, not cosmetic: it is the engine's last-resort
 * tiebreaker, and it works by this array's order surviving a stable sort in
 * resolvePrize. Return these in any other order and full ties change winner.
 */
export function buildStandings(
  stats: Iterable<GamePlayerStat>,
  config: ScoringConfig,
  roster: string[],
): PlayerStanding[] {
  const standings = new Map<string, PlayerStanding>(
    roster.map((name) => [
      name,
      { player: name, win_points: 0, total_damage: 0, games_played: 0, totals: {}, peaks: {} },
    ]),
  );

  for (const s of stats) {
    const st = standings.get(s.player);
    // Ignore stray records not on the roster.
    if (st === undefined) continue;
    // Seated, nothing recorded. Counting it would make the player a contender
    // on zeros, and zero wins every `min` prize.
    if (!s.played) continue;

    st.games_played += 1;
    st.win_points += (s.placement === null ? undefined : config.placement_points.get(s.placement)) ?? 0;
    for (const f of config.total_damage_fields) st.total_damage += statField(s, f);
    for (const f of SUMMABLE) {
      const v = s[f];
      st.totals[f] = (st.totals[f] ?? 0) + v;
      st.peaks[f] = Math.max(st.peaks[f] ?? 0, v);
    }
  }

  return roster.map((name) => standings.get(name)!);
}

function metricValue(st: PlayerStanding, prize: Prize): number {
  if (prize.metric === "win_points") return st.win_points;
  if (prize.scope === "peak") return st.peaks[prize.metric] ?? 0;
  return st.totals[prize.metric] ?? 0;
}

function tiebreakValue(st: PlayerStanding, tb: Tiebreak): number {
  if (tb.field === "total_damage") return st.total_damage;
  if (tb.field === "win_points") return st.win_points;
  if (tb.scope === "peak") return st.peaks[tb.field] ?? 0;
  return st.totals[tb.field] ?? 0;
}

/**
 * The prize's winner, or null when nobody has earned it yet.
 *
 * "Nobody has earned it" is asymmetric between the two aggregations, and the
 * asymmetry is the point:
 *
 *  - A `max` prize rewards doing the most of something. A winning value of zero
 *    means the whole field did none of it, so there is no winner. Awarding it
 *    anyway hands the prize to whoever sorts first, which after round one is
 *    simply the first name on the roster: the difference between "Alice milled
 *    the most" and "nobody milled, and Alice is called Alice".
 *  - A `min` prize rewards doing the least, so zero is the best possible score
 *    and a genuine win. "40 Is More Than 21" is meant to go to the player who
 *    dealt no commander damage at all. That is only safe because a contender
 *    has to have played: merely being seated is not enough.
 *
 * `ineligible` players are not contenders at all, so a prize they would have
 * won goes to the runner-up, and the unclaimed rule then applies to that
 * runner-up's value. Required rather than defaulted, because a caller that
 * forgot it would award an excluded player without a word.
 */
export function resolvePrize(
  prize: Prize,
  standings: PlayerStanding[],
  ineligible: readonly string[],
): PrizeResult {
  const winner = prizeRanking(prize, standings, ineligible).find((r) => r.eligible);
  if (!winner) return { key: prize.key, name: prize.name, winner: null, value: null };
  if (prize.agg === "max" && winner.value <= 0) {
    return { key: prize.key, name: prize.name, winner: null, value: null };
  }
  return { key: prize.key, name: prize.name, winner: winner.player, value: winner.value };
}

/**
 * Everyone who has played, in the order the prize ranks them.
 *
 * resolvePrize reads its winner off the front of this list, so the two cannot
 * disagree. Ineligible players are ranked with everyone else and flagged rather
 * than left out: the list answers "where did I come", and the prize goes to the
 * first eligible row.
 *
 * Ranks are shared on a tie of both the metric and the tiebreak (1, 2, 2, 4).
 * The prize itself still goes to the earlier of a fully tied pair in roster
 * order, as resolvePrize documents.
 */
export function prizeRanking(
  prize: Prize,
  standings: PlayerStanding[],
  ineligible: readonly string[],
): PrizeRankRow[] {
  // For max we want the largest first, for min the smallest, so both can be
  // read off the front after sorting. Array.prototype.sort has been stable
  // since ES2019, and standings arrives in roster order, so a pair level on
  // both keys keeps roster order -- the documented last resort.
  const keyOf = (st: PlayerStanding): [number, number] => {
    const primary = metricValue(st, prize);
    const primaryKey = prize.agg === "max" ? -primary : primary;
    let tbKey = 0;
    if (prize.tiebreak) {
      const tb = tiebreakValue(st, prize.tiebreak);
      tbKey = prize.tiebreak.direction === "max" ? -tb : tb;
    }
    return [primaryKey, tbKey];
  };
  const ordered = standings
    .filter((s) => s.games_played > 0)
    .map((st) => ({ st, key: keyOf(st) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1]);

  const rows: PrizeRankRow[] = [];
  ordered.forEach(({ st, key }, i) => {
    const prev = ordered[i - 1];
    const tied = i > 0 && key[0] === prev!.key[0] && key[1] === prev!.key[1];
    rows.push({
      rank: tied ? rows[i - 1]!.rank : i + 1,
      player: st.player,
      value: metricValue(st, prize),
      tiebreak: prize.tiebreak ? tiebreakValue(st, prize.tiebreak) : null,
      eligible: !ineligible.includes(st.player),
    });
  });
  return rows;
}

/**
 * Standings in board order, each paired with its competition rank.
 *
 * Ties share a rank and consume the places below them (1, 2, 2, 4). Two players
 * level on both win points and the damage tiebreaker are not first and second,
 * they are joint first, and numbering them 1 and 2 puts one above the other on
 * the projector on no authority but sort order.
 *
 * Players yet to play are all level on zero, so they share the last rank.
 */
export function rankedStandings(standings: PlayerStanding[]): [number, PlayerStanding][] {
  // Copied before sorting: a caller that still holds the roster-ordered array
  // needs it to stay that way.
  const ordered = [...standings].sort(
    (a, b) => b.win_points - a.win_points || b.total_damage - a.total_damage,
  );
  const ranked: [number, PlayerStanding][] = [];
  ordered.forEach((st, i) => {
    const prev = ordered[i - 1];
    const tied =
      i > 0 && st.win_points === prev!.win_points && st.total_damage === prev!.total_damage;
    ranked.push([tied ? ranked[i - 1]![0] : i + 1, st]);
  });
  return ranked;
}

export function leaderboard(
  stats: Iterable<GamePlayerStat>,
  config: ScoringConfig,
  roster: string[],
): PrizeResult[] {
  const standings = buildStandings(stats, config, roster);
  return config.prizes.map((p) => resolvePrize(p, standings, config.prize_ineligible));
}

/**
 * Event config as it arrives from outside: parsed YAML today, a D1 row later.
 * Looser than ScoringConfig on purpose -- placement_points keyed by string,
 * prize_ineligible possibly a bare name, tiebreak possibly absent -- because
 * that is what a config file is allowed to look like.
 */
export interface EventConfigInput {
  scoring: {
    placement_points: Record<string, number> | Map<number, number>;
    total_damage_fields: string[];
    prize_ineligible?: string | string[] | null;
  };
  prizes: {
    key: string;
    name: string;
    metric: string;
    agg: "max" | "min";
    scope: "night" | "peak";
    tiebreak?: { field: string; direction: "max" | "min"; scope?: "night" | "peak" } | null;
  }[];
}

/** Build a ScoringConfig from event configuration as it comes out of D1. */
export function scoringConfigFrom(cfg: EventConfigInput): ScoringConfig {
  const pp = cfg.scoring.placement_points;
  const placement_points =
    pp instanceof Map
      ? new Map(pp)
      : new Map(Object.entries(pp).map(([k, v]) => [Number(k), Number(v)]));

  // A lone name is easy to write without the brackets, and iterating the bare
  // string would exclude the letters J, e and s instead of Jesse.
  const raw = cfg.scoring.prize_ineligible ?? [];
  const prize_ineligible = (typeof raw === "string" ? [raw] : raw).map(String);

  return {
    placement_points,
    total_damage_fields: [...cfg.scoring.total_damage_fields],
    prize_ineligible,
    prizes: cfg.prizes.map((p) => ({
      key: p.key,
      name: p.name,
      metric: p.metric,
      agg: p.agg,
      scope: p.scope,
      tiebreak: p.tiebreak
        ? { field: p.tiebreak.field, direction: p.tiebreak.direction, scope: p.tiebreak.scope ?? "night" }
        : null,
    })),
  };
}
