// The gate on the TypeScript port: the real Fall 2026 night, scored by both
// engines, must come out identical.
//
// shared/fixtures/fall-2026.json is the actual event as recorded on the night
// -- 8 players, 2 pods, 3 matches, 156 turn rows -- with the players' names
// replaced by pseudonyms in the same roster order. Order is preserved because
// roster order is the engine's last-resort tiebreaker, so shuffling the names
// would change which player wins a full tie and quietly weaken this test.
//
// `derived` is what the aggregation query makes of `raw`; `expected` is what
// the scoring engine makes of `derived`. Both were recorded from the event.
//
// Why a real night on top of the hand-built sample in scoring.test.ts: the
// sample was designed, so it only contains cases somebody thought of. This one
// contains what actually happened, including a 9999-damage attack against the
// old input cap and a `min` prize won on a value of zero.

import { expect, test } from "vitest";
import { fixture } from "./fixtures/fall-2026.ts";
import {
  buildStandings,
  leaderboard,
  prizeRanking,
  rankedStandings,
  scoringConfigFrom,
} from "./scoring.ts";

const derived = fixture.derived;
const config = scoringConfigFrom(fixture);
const roster = fixture.roster;

test("the recorded standings come out unchanged", () => {
  expect(buildStandings(derived, config, roster)).toEqual(fixture.expected.standings);
});

test("the recorded board order and ranks come out unchanged", () => {
  const ranked = rankedStandings(buildStandings(derived, config, roster));
  expect(ranked.map(([rank, st]) => [rank, st.player])).toEqual(fixture.expected.ranked);
});

test("the recorded prize winners come out unchanged", () => {
  expect(leaderboard(derived, config, roster)).toEqual(fixture.expected.prizes);
});

test("the night is complete enough to be worth testing against", () => {
  // Guards the fixture itself. A truncated or half-regenerated file would make
  // every assertion above pass against nothing, which is the failure mode of a
  // golden test nobody notices.
  expect(roster.length).toBe(8);
  expect(derived.length).toBe(24);
  expect(fixture.expected.prizes.length).toBe(11);
  expect(fixture.expected.prizes.filter((p) => p.winner !== null).length).toBe(11);
  // The organiser plays, scores, and takes no prize.
  expect(config.prize_ineligible.length).toBe(1);
  const ineligible = config.prize_ineligible[0]!;
  expect(roster).toContain(ineligible);
  expect(fixture.expected.prizes.map((p) => p.winner)).not.toContain(ineligible);
  expect(fixture.expected.standings.find((s) => s.player === ineligible)!.games_played).toBe(3);
});

// --- Full prize rankings ------------------------------------------------------

const standings = buildStandings(derived, config, roster);
const ranking = (key: string) =>
  prizeRanking(config.prizes.find((p) => p.key === key)!, standings, config.prize_ineligible);

test("each prize's ranking starts its eligible rows with the recorded winner", () => {
  for (const [i, prize] of config.prizes.entries()) {
    const rows = prizeRanking(prize, standings, config.prize_ineligible);
    expect(rows.find((r) => r.eligible)!.player, prize.key).toBe(fixture.expected.prizes[i]!.winner);
  }
});

test("each prize ranks every player who played, once", () => {
  for (const prize of config.prizes) {
    const rows = prizeRanking(prize, standings, config.prize_ineligible);
    expect([...rows.map((r) => r.player)].sort(), prize.key).toEqual([...roster].sort());
  }
});

test("the organiser is ranked where they finished and flagged, not dropped", () => {
  // Alice made the biggest single attack by creature count but takes no prize,
  // so she is first in the list and the prize is Bob's.
  const rows = ranking("how_many_were_1_1s");
  expect(rows[0]).toEqual({ rank: 1, player: "Alice", value: 10, tiebreak: 45, eligible: false });
  expect(rows[1]).toEqual({ rank: 2, player: "Bob", value: 8, tiebreak: 503, eligible: true });
  expect(rows.filter((r) => !r.eligible).map((r) => r.player)).toEqual(["Alice"]);
});

test("a full ranking is in the prize's direction with shared ranks on a full tie", () => {
  // Frank and Grace are level on win points and on total damage, so they share
  // sixth and Dave is eighth.
  expect(ranking("technical_winner").map((r) => [r.rank, r.player, r.value, r.tiebreak])).toEqual([
    [1, "Carol", 11, 10120],
    [2, "Erin", 10, 73],
    [3, "Bob", 9, 503],
    [4, "Heidi", 8, 79],
    [5, "Alice", 8, 45],
    [6, "Frank", 5, 2],
    [6, "Grace", 5, 2],
    [8, "Dave", 4, 0],
  ]);
  // The same metric, lowest first, with the tiebreak reversed as configured.
  expect(ranking("blame_it_on_shuffling").map((r) => [r.rank, r.player])).toEqual([
    [1, "Dave"],
    [2, "Frank"],
    [2, "Grace"],
    [4, "Alice"],
    [5, "Heidi"],
    [6, "Bob"],
    [7, "Erin"],
    [8, "Carol"],
  ]);
});

test("a tie on the metric alone is split by the tiebreak, not shared", () => {
  // Grace and Dave both dealt no commander damage; Grace dealt more combat
  // damage, which is this prize's tiebreak.
  const rows = ranking("forty_more_than_twenty_one");
  expect(rows.slice(0, 2).map((r) => [r.rank, r.player, r.value])).toEqual([
    [1, "Grace", 0],
    [2, "Dave", 0],
  ]);
});
