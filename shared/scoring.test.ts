// Scoring verification against a known 4-player / 3-game sample.
//
// Expected winners were computed independently and hand-checked.

import { describe, expect, test } from "vitest";
import { fixture } from "./fixtures/fall-2026.ts";
import {
  KNOWN_FIELDS,
  type GamePlayerStat,
  type ScoringConfig,
  buildStandings,
  gamePlayerStat,
  leaderboard,
  rankedStandings,
  scoringConfigFrom,
} from "./scoring.ts";

// The prize definitions in the fixture are config/event.example.yaml's,
// verbatim -- the live event config was diffed against the example and only
// the roster, prize_ineligible and secure_cookies differed. Taking them from
// here rather than re-parsing the YAML keeps one copy of the prize list.
const RAW_CONFIG = { scoring: fixture.scoring, prizes: fixture.prizes };

function config(): ScoringConfig {
  return scoringConfigFrom({ ...RAW_CONFIG, scoring: { ...RAW_CONFIG.scoring, prize_ineligible: [] } });
}

function excluding(...names: string[]): ScoringConfig {
  return scoringConfigFrom({ ...RAW_CONFIG, scoring: { ...RAW_CONFIG.scoring, prize_ineligible: names } });
}

// game_id, player, placement, final_life, combat, noncombat, cmdr, opp,
// big_dealt, big_taken, creatures, graveyard
const ROWS: [number, string, number, number, number, number, number, number, number, number, number, number][] = [
  [1, "Alice", 1, 5, 40, 3, 12, 2, 15, 6, 5, 18],
  [1, "Bob", 2, -3, 22, 0, 0, 0, 12, 15, 3, 20],
  [1, "Carol", 3, -8, 10, 8, 0, 1, 8, 40, 2, 30],
  [1, "Dave", 4, -11, 5, 0, 0, 0, 4, 9, 1, 12],
  [2, "Alice", 4, -6, 9, 0, 0, 0, 7, 20, 2, 14],
  [2, "Bob", 1, 12, 35, 2, 21, 3, 30, 5, 4, 16],
  [2, "Carol", 2, -1, 18, 5, 0, 0, 11, 12, 3, 25],
  [2, "Dave", 3, -4, 14, 0, 0, 0, 9, 18, 2, 10],
  [3, "Alice", 2, 4, 20, 1, 0, 1, 13, 8, 3, 11],
  [3, "Bob", 3, -5, 16, 0, 6, 0, 10, 14, 2, 19],
  [3, "Carol", 1, 7, 28, 12, 0, 2, 22, 6, 9, 40],
  [3, "Dave", 4, -9, 6, 0, 0, 0, 5, 22, 1, 13],
];

const STATS: GamePlayerStat[] = ROWS.map((r) =>
  gamePlayerStat({
    game_id: r[0], player: r[1], placement: r[2], final_life: r[3],
    combat_dmg_dealt: r[4], noncombat_dmg_dealt: r[5], cmdr_dmg_dealt: r[6],
    opps_eliminated: r[7], biggest_attack_dealt: r[8], biggest_attack_taken: r[9],
    most_creatures_in_attack: r[10], total_graveyard: r[11],
  }),
);

const ROSTER = ["Alice", "Bob", "Carol", "Dave"];

const EXPECTED: Record<string, [string | null, number | null]> = {
  // Bob and Carol tie on 9 win points, so the configured tiebreaker decides.
  // It is combat damage dealt: Bob 73, Carol 56 -> Bob.
  // This flipped when the event owner set the tiebreaker to combat-only. Under
  // the previous combat+non-combat rule Carol took it 81 to 75, because her 25
  // points of non-combat damage outweighed Bob's 17-point lead in combat. If
  // this assertion ever fails, check total_damage_fields in the config before
  // suspecting the scoring engine -- the engine is generic and this expectation
  // is a function of that list.
  technical_winner: ["Bob", 9],
  blame_it_on_shuffling: ["Dave", 4],
  does_nobody_block: ["Bob", 73],
  no_apologies: ["Bob", 30],
  you_should_see_the_other_guy: ["Carol", 40],
  how_many_were_1_1s: ["Carol", 9],
  cant_spell_million_without_mill: ["Carol", 40],
  twenty_one_less_than_forty: ["Bob", 27],
  // Carol and Dave both dealt no commander damage; most combat breaks it, 56 to 25.
  forty_more_than_twenty_one: ["Carol", 0],
  // Alice, Bob and Carol all eliminated 3; most combat breaks it: Bob 73, Alice 69,
  // Carol 56. Roster order gave this to Alice before every prize had a tiebreak.
  assassin_or_asshole: ["Bob", 3],
  scared_of_the_sword: ["Carol", 25],
};

function byKey(stats: GamePlayerStat[], cfg = config()): Record<string, [string | null, number | null]> {
  return Object.fromEntries(leaderboard(stats, cfg, ROSTER).map((r) => [r.key, [r.winner, r.value]]));
}

/** One complete game in which every stat is zero unless named. */
function flat(overrides: Partial<GamePlayerStat> = {}): GamePlayerStat[] {
  return ROSTER.map((p, i) => gamePlayerStat({ game_id: 1, player: p, placement: i + 1, ...overrides }));
}

test("leaderboard matches expected", () => {
  expect(byKey(STATS)).toEqual(EXPECTED);
});

test("empty event has no winners", () => {
  for (const r of leaderboard([], config(), ROSTER)) {
    expect(r.winner).toBeNull();
    expect(r.value).toBeNull();
  }
});

// --- unclaimed prizes -------------------------------------------------------
//
// The gap that let a real bug through: the sample above has a winner for
// everything, and the empty-event case has a winner for nothing. Neither
// exercises the case the projector actually spends round one in -- games
// recorded, but nobody having done the thing a prize rewards.

describe("unclaimed prizes", () => {
  test("max prizes are unclaimed while the field is on zero", () => {
    // Nobody milled a card, so nobody wins the mill prize. Awarding it anyway
    // handed every "most X" prize to whoever sorted first, which after one
    // round is simply the first name on the roster: the board read "9 of 11
    // claimed" with Alice's name on all nine.
    const results = byKey(flat());
    for (const key of [
      "does_nobody_block",
      "no_apologies",
      "you_should_see_the_other_guy",
      "how_many_were_1_1s",
      "cant_spell_million_without_mill",
      "twenty_one_less_than_forty",
      "assassin_or_asshole",
      "scared_of_the_sword",
    ]) {
      expect(results[key], key).toEqual([null, null]);
    }
  });

  test("min prizes still award at zero", () => {
    // The other half of the same rule. Zero is the best possible score for a
    // `min` prize -- "40 Is More Than 21" is meant to go to whoever dealt no
    // commander damage at all, so it must not be swept up as unclaimed.
    expect(byKey(flat())["forty_more_than_twenty_one"]).toEqual(["Alice", 0]);
  });

  test("a seated player who has not played is not a contender", () => {
    // The repository derives a row for everyone seated, before they have done
    // anything. Zero is a winning score for a `min` prize, so a row that only
    // means "sat down" must not count as a game played, or the first name on
    // the roster wins "40 Is More Than 21" before a card is drawn.
    const seated = ROSTER.map((p) =>
      gamePlayerStat({ game_id: 1, player: p, placement: null, played: false }),
    );
    for (const [winner] of Object.values(byKey(seated))) expect(winner).toBeNull();
  });

  test("a max prize is claimed as soon as one player scores", () => {
    const results = byKey([
      gamePlayerStat({ game_id: 1, player: "Alice", placement: 1 }),
      gamePlayerStat({ game_id: 1, player: "Bob", placement: 2, total_graveyard: 7 }),
      gamePlayerStat({ game_id: 1, player: "Carol", placement: 3 }),
      gamePlayerStat({ game_id: 1, player: "Dave", placement: 4 }),
    ]);
    expect(results["cant_spell_million_without_mill"]).toEqual(["Bob", 7]);
  });

  test("win point prizes survive a partly played event", () => {
    // Pod A has played, pod B has not. Only players with a game contend, so the
    // wooden spoon must not go to somebody who has not sat down yet.
    const results = byKey([
      gamePlayerStat({ game_id: 1, player: "Alice", placement: 1, combat_dmg_dealt: 10 }),
      gamePlayerStat({ game_id: 1, player: "Bob", placement: 2, combat_dmg_dealt: 5 }),
    ]);
    expect(results["technical_winner"]).toEqual(["Alice", 4]);
    expect(results["blame_it_on_shuffling"]).toEqual(["Bob", 3]);
  });

  test("a player still in the game scores no win points", () => {
    // Mid-match is the normal state here, not an edge case: turns are recorded
    // while placement is still null, which is exactly what lets the projected
    // board stay live during a game. Read as anything but zero -- `?? 1`, a
    // default, a cast -- and every match would show win points nobody had
    // earned yet, correcting itself only once the deaths were entered.
    //
    // The game and the damage still count. Only the placement points wait.
    const live = [
      gamePlayerStat({ game_id: 1, player: "Alice", placement: null, combat_dmg_dealt: 30 }),
      gamePlayerStat({ game_id: 1, player: "Bob", placement: 4, combat_dmg_dealt: 1 }),
    ];
    const byPlayer = new Map(buildStandings(live, config(), ROSTER).map((s) => [s.player, s]));
    expect(byPlayer.get("Alice")!.win_points).toBe(0);
    expect(byPlayer.get("Alice")!.games_played).toBe(1);
    expect(byPlayer.get("Alice")!.totals["combat_dmg_dealt"]).toBe(30);
    expect(byPlayer.get("Bob")!.win_points).toBe(1);
    // So the wooden spoon sits with the player yet to finish, not the one who
    // has: a `min` prize on zero is a real win.
    expect(byKey(live)["blame_it_on_shuffling"]).toEqual(["Alice", 0]);
  });
});

// --- tiebreaks --------------------------------------------------------------

describe("tiebreaks", () => {
  test("tiebreak beats roster order but roster order is the last resort", () => {
    const tied = [
      gamePlayerStat({ game_id: 1, player: "Alice", placement: 1, combat_dmg_dealt: 10 }),
      gamePlayerStat({ game_id: 1, player: "Bob", placement: 1, combat_dmg_dealt: 30 }),
      gamePlayerStat({ game_id: 1, player: "Carol", placement: 1, combat_dmg_dealt: 30 }),
    ];
    // Bob and Carol are level on win points; Bob wins on damage over Alice, and
    // over Carol only because the roster puts him first.
    expect(byKey(tied)["technical_winner"]).toEqual(["Bob", 4]);
  });

  test("does nobody block ties go to the most creatures attacked with", () => {
    // Level on damage, whoever sent more creatures over the whole night wins.
    // Bob has the bigger single swing and sorts after Alice, so neither a peak
    // reading nor roster order picks Alice: only the night total does.
    const tied = [
      gamePlayerStat({ game_id: 1, player: "Alice", placement: 1, combat_dmg_dealt: 10, most_creatures_in_attack: 3, creatures_attacked_with: 4 }),
      gamePlayerStat({ game_id: 2, player: "Alice", placement: 1, combat_dmg_dealt: 10, most_creatures_in_attack: 3, creatures_attacked_with: 4 }),
      gamePlayerStat({ game_id: 1, player: "Bob", placement: 2, combat_dmg_dealt: 20, most_creatures_in_attack: 5, creatures_attacked_with: 5 }),
      gamePlayerStat({ game_id: 1, player: "Carol", placement: 3, combat_dmg_dealt: 20, most_creatures_in_attack: 1, creatures_attacked_with: 9 }),
    ];
    expect(byKey(tied)["does_nobody_block"]).toEqual(["Carol", 20]);
  });

  test("you should see the other guy ties go to the most damage taken", () => {
    const tied = [
      gamePlayerStat({ game_id: 1, player: "Alice", placement: 1, biggest_attack_taken: 8, combat_dmg_taken: 8 }),
      gamePlayerStat({ game_id: 1, player: "Bob", placement: 2, biggest_attack_taken: 8, combat_dmg_taken: 19 }),
    ];
    expect(byKey(tied)["you_should_see_the_other_guy"]).toEqual(["Bob", 8]);
  });

  test("the mill prize ties go to the most win points", () => {
    const tied = [
      gamePlayerStat({ game_id: 1, player: "Alice", placement: 4, total_graveyard: 30 }),
      gamePlayerStat({ game_id: 1, player: "Bob", placement: 1, total_graveyard: 30 }),
    ];
    expect(byKey(tied)["cant_spell_million_without_mill"]).toEqual(["Bob", 30]);
  });

  test("scared of the sword ties go to the least combat damage", () => {
    const tied = [
      gamePlayerStat({ game_id: 1, player: "Alice", placement: 1, noncombat_dmg_dealt: 6, combat_dmg_dealt: 30 }),
      gamePlayerStat({ game_id: 1, player: "Bob", placement: 2, noncombat_dmg_dealt: 6, combat_dmg_dealt: 2 }),
    ];
    expect(byKey(tied)["scared_of_the_sword"]).toEqual(["Bob", 6]);
  });

  test("every configured tiebreak names a real stat", () => {
    // An unknown field reads as zero for everyone, so a typo in a prize's
    // configuration would quietly turn a tiebreak back into roster order.
    for (const prize of config().prizes) {
      expect(prize.tiebreak, prize.key).not.toBeNull();
      expect(KNOWN_FIELDS, prize.key).toContain(prize.tiebreak!.field);
    }
  });
});

// --- players who cannot win a prize -----------------------------------------

describe("prize_ineligible", () => {
  test("a lone ineligible name without brackets is that name", () => {
    // `prize_ineligible: Jesse` is easy to write. Iterated as a string it
    // excluded the letters J, e and s, and Jesse could win again.
    const cfg = scoringConfigFrom({
      ...RAW_CONFIG,
      scoring: { ...RAW_CONFIG.scoring, prize_ineligible: "Jesse" },
    });
    expect(cfg.prize_ineligible).toEqual(["Jesse"]);
  });

  test("an ineligible player hands every prize to the runner up", () => {
    // Alice wins every prize in this game; excluded, each goes to the next in line.
    const stats = [
      gamePlayerStat({ game_id: 1, player: "Alice", placement: 1, combat_dmg_dealt: 40, opps_eliminated: 3 }),
      gamePlayerStat({ game_id: 1, player: "Bob", placement: 2, combat_dmg_dealt: 10, opps_eliminated: 1 }),
      gamePlayerStat({ game_id: 1, player: "Carol", placement: 3, combat_dmg_dealt: 5 }),
    ];
    const won = byKey(stats, excluding("Alice"));
    expect(won["technical_winner"]).toEqual(["Bob", 3]);
    expect(won["does_nobody_block"]).toEqual(["Bob", 10]);
    expect(won["assassin_or_asshole"]).toEqual(["Bob", 1]);
    expect(Object.values(won).map(([w]) => w)).not.toContain("Alice");
  });

  test("a runner up on zero leaves the prize unclaimed", () => {
    // Only Alice eliminated anyone. The next in line has 0, and a `max` prize
    // on 0 is unclaimed rather than handed to whoever sorts first.
    const stats = [
      gamePlayerStat({ game_id: 1, player: "Alice", placement: 1, opps_eliminated: 3 }),
      gamePlayerStat({ game_id: 1, player: "Bob", placement: 2 }),
    ];
    expect(byKey(stats, excluding("Alice"))["assassin_or_asshole"]).toEqual([null, null]);
  });

  test("an ineligible player still tops the standings", () => {
    const stats = [
      gamePlayerStat({ game_id: 1, player: "Alice", placement: 1 }),
      gamePlayerStat({ game_id: 1, player: "Bob", placement: 2 }),
    ];
    const ranked = rankedStandings(buildStandings(stats, excluding("Alice"), ROSTER));
    expect(ranked[0]![0]).toBe(1);
    expect(ranked[0]![1].player).toBe("Alice");
  });
});

// --- rankedStandings --------------------------------------------------------

describe("rankedStandings", () => {
  test("ties share a rank and consume the places below", () => {
    const stats = [
      gamePlayerStat({ game_id: 1, player: "Alice", placement: 1, combat_dmg_dealt: 10 }),
      gamePlayerStat({ game_id: 1, player: "Bob", placement: 2, combat_dmg_dealt: 7 }),
      gamePlayerStat({ game_id: 1, player: "Carol", placement: 2, combat_dmg_dealt: 7 }),
      gamePlayerStat({ game_id: 1, player: "Dave", placement: 4, combat_dmg_dealt: 1 }),
    ];
    const standings = buildStandings(stats, config(), ROSTER);
    expect(rankedStandings(standings).map(([rank, s]) => [rank, s.player])).toEqual([
      [1, "Alice"],
      [2, "Bob"],
      [2, "Carol"], // level on points AND damage -> joint second
      [4, "Dave"],  // third place is consumed by the tie
    ]);
  });

  test("players yet to play are all level at the bottom", () => {
    const stats = [gamePlayerStat({ game_id: 1, player: "Alice", placement: 1 })];
    const ranked = rankedStandings(buildStandings(stats, config(), ROSTER));
    expect(ranked[0]![0]).toBe(1);
    expect(ranked.slice(1).map(([rank]) => rank)).toEqual([2, 2, 2]);
  });

  test("the roster-ordered array it was given is left in roster order", () => {
    // A sort in place would reorder the caller's standings and silently change
    // the roster-order tiebreak that resolvePrize depends on.
    const standings = buildStandings(STATS, config(), ROSTER);
    rankedStandings(standings);
    expect(standings.map((s) => s.player)).toEqual(ROSTER);
  });
});
