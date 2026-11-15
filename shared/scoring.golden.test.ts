// The gate on the TypeScript port: the real Fall 2026 night, scored by both
// engines, must come out identical.
//
// shared/fixtures/fall-2026.json is the actual event as recorded on the night
// -- 8 players, 2 pods, 3 matches, 156 turn rows -- with the players' names
// replaced by pseudonyms in the same roster order. Order is preserved because
// roster order is the engine's last-resort tiebreaker, so shuffling the names
// would change which player wins a full tie and quietly weaken this test.
//
// `derived` and `expected` in that file were produced by running app/scoring.py
// (via app/repository.py's aggregation) over `raw`. scripts/fixture_expected.py
// regenerates them and is what keeps Python the reference implementation: if it
// and this file ever disagree, the engines have diverged.
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
  rankedStandings,
  scoringConfigFrom,
} from "./scoring.ts";

const derived = fixture.derived;
const config = scoringConfigFrom(fixture);
const roster = fixture.roster;

test("the real night's standings match Python's", () => {
  expect(buildStandings(derived, config, roster)).toEqual(fixture.expected.standings);
});

test("the real night's board order and ranks match Python's", () => {
  const ranked = rankedStandings(buildStandings(derived, config, roster));
  expect(ranked.map(([rank, st]) => [rank, st.player])).toEqual(fixture.expected.ranked);
});

test("the real night's prize winners match Python's", () => {
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
