// The entry rules, held to Python's answers case for case.
//
// shared/fixtures/entry-rules.json is app/routes/entry.py's own output over 61
// cases, captured by scripts/entry_rules_fixture.py and kept honest by
// tests/test_entry_rules_fixture.py. These are the rules the event owner
// settled, and all of them fail silently: a wrong placement, a death prompt
// that never appears, a tracker landing on a turn already saved. None of that
// raises anything, so the only way to know the port agrees is to ask it the
// same questions.

import { describe, expect, test } from "vitest";
import { entryRules as fixture } from "../shared/fixtures/entry-rules.ts";
import {
  enteredKey,
  eliminationPrompt,
  expectedPodSize,
  finishingOrder,
  nextUp,
  ordinal,
  placementLabel,
  seatAfter,
} from "./entry-rules.ts";

const POINTS = new Map(
  Object.entries(fixture.placement_points).map(([k, v]) => [Number(k), v]),
);
const TABLE = fixture.table;

describe("ordinals", () => {
  test.for(fixture.ordinals)(
    "$n is $ordinal",
    ({ n, ordinal: want }) => {
      expect(ordinal(n)).toBe(want);
    },
  );
});

describe("placement labels", () => {
  test.for(fixture.placement_labels)(
    "place $place on $points points reads $label",
    ({ place, points, label }) => {
      expect(placementLabel(place, points)).toBe(label);
    },
  );
});

describe("finishing order", () => {
  test.for(
    fixture.finishing_orders,
  )(
    "$rows with $still_in in, simultaneous=$simultaneous",
    ({ rows, still_in, simultaneous, places }) => {
      const got = finishingOrder(rows, still_in, simultaneous);
      expect(Object.fromEntries(got)).toEqual(places);
    },
  );

  test("a tie takes the better placement and leaves the rest unused", () => {
    // Stated on its own as well as inside the table above, because it is the
    // rule most likely to be "corrected" by somebody reading the code later.
    const places = finishingOrder(
      [
        ["Dave", -5],
        ["Carol", -5],
      ],
      4,
      true,
    );
    expect(places.get("Dave")).toBe(3);
    expect(places.get("Carol")).toBe(3);
    expect([...places.values()]).not.toContain(4);
  });

  test("the tracker's order is kept when lives are equal", () => {
    // Stable sort. Not observable through the placements, since tied players
    // share one, but it is what makes the non-tied neighbours line up.
    const places = finishingOrder(
      [
        ["Dave", -5],
        ["Carol", -5],
        ["Bob", -1],
      ],
      4,
      true,
    );
    expect(Object.fromEntries(places)).toEqual({ Dave: 3, Carol: 3, Bob: 2 });
  });
});

describe("elimination prompt", () => {
  test.for(
    fixture.elimination_prompts,
  )(
    "out=$out credits=$credits just=$just_credited",
    ({ out, credits, just_credited, ...want }) => {
      const got = eliminationPrompt(
        TABLE,
        new Map(Object.entries(out)),
        credits.map(([, n]) => n),
        POINTS,
        just_credited,
      );
      expect(got.deaths_due).toBe(want.deaths_due);
      expect(got.elimination_rows).toEqual(want.elimination_rows);
      expect(got.elimination_candidates).toEqual(want.elimination_candidates);
      expect(got.winner_row).toEqual(want.winner_row);
    },
  );

  test("the winner is not counted as a recorded death", () => {
    // Otherwise the last elimination of every game is hidden: the kill that
    // ends it is credited, the winner holds 1st, and the arithmetic cancels.
    const out = new Map([
      ["Dave", 4],
      ["Carol", 3],
      ["Alice", 1],
    ]);
    expect(eliminationPrompt(TABLE, out, [3], POINTS).deaths_due).toBe(1);
  });
});

describe("who is next", () => {
  test.for(
    fixture.next_up,
  )("out=$out entered=$entered played=$played", ({ out, entered, played, ...want }) => {
    const got = nextUp(
      TABLE,
      new Set(out),
      new Set(entered.map(([n, r]) => enteredKey(n, r))),
      played,
    );
    expect(got.player).toBe(want.player);
    expect(got.round_no).toBe(want.round_no);
  });

  test.for(
    fixture.seat_after,
  )("after $player with $out out", ({ out, player, round_no, ...want }) => {
    const got = seatAfter(TABLE, new Set(out), player, round_no);
    expect(got.player).toBe(want.next_player);
    expect(got.round_no).toBe(want.next_round);
  });
});

describe("pod size", () => {
  test.for(
    fixture.pod_sizes,
  )("pod_size=$pod_size with $placements", ({ pod_size, placements, expected }) => {
    expect(expectedPodSize(pod_size, placements)).toBe(expected);
  });
});
