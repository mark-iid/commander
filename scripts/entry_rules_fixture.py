#!/usr/bin/env python3
"""Record what app/routes/entry.py's rules decide, so the Worker can match.

Phase 2 of ADR 0003 reimplements the entry surface in TypeScript. Most of it is
forms and SQL, but a handful of pure functions hold the rules the event owner
actually settled, and every one of them fails silently when it is wrong:

  _finishing_order     placements from the order players went out, including
                       simultaneous deaths ranked by life and ties taking the
                       better placement
  _elimination_prompt  how many death rows are outstanding: eliminations
                       credited on the turns minus the players already recorded
                       out, with the winner excluded and a just-credited floor
  _next_up             who a tracker opening a table lands on
  _seat_after          who plays next, skipping players already out
  _ordinal             1st, 2nd, 11th, 21st, for placements that come from
                       config and are not limited to a pod of four

A divergence in any of them produces a plausible wrong answer rather than an
error: a player credited the wrong placement, a death prompt that never
appears, a tracker landing on a turn that is already saved.

So this enumerates cases, records Python's answers, and
worker/entry-rules.test.ts requires the same ones.

    python3 scripts/entry_rules_fixture.py --check
    python3 scripts/entry_rules_fixture.py --write

`--check` runs in the pytest suite (tests/test_entry_rules_fixture.py).
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
from dataclasses import dataclass

REPO = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from app.routes.entry import (  # noqa: E402
    _elimination_prompt,
    _expected_pod_size,
    _finishing_order,
    _next_up,
    _ordinal,
    _placement_label,
    _seat_after,
)

FIXTURE = REPO / "shared" / "fixtures" / "entry-rules.json"

POINTS = {1: 4, 2: 3, 3: 2, 4: 1}
TABLE = ["Alice", "Bob", "Carol", "Dave"]


@dataclass
class FakeTurn:
    """What _elimination_prompt reads off a turn_grid value."""

    opps_eliminated: int


def _ordinals() -> list[dict]:
    # Every suffix rule, including the teens, and placements past a pod of four
    # because placement_points is config.
    ns = [1, 2, 3, 4, 5, 10, 11, 12, 13, 14, 20, 21, 22, 23, 24, 100, 101, 111, 112]
    return [{"n": n, "ordinal": _ordinal(n)} for n in ns]


def _placement_labels() -> list[dict]:
    cases = [(1, 4), (2, 3), (3, 2), (4, 1), (5, 0), (11, 1), (21, 2)]
    return [
        {"place": p, "points": pts, "label": _placement_label(p, pts)} for p, pts in cases
    ]


def _finishing_orders() -> list[dict]:
    cases = [
        # One at a time out of a table of four: first out finishes 4th.
        {"rows": [["Dave", -3]], "still_in": 4, "simultaneous": False},
        {"rows": [["Dave", -3], ["Carol", -8]], "still_in": 4, "simultaneous": False},
        {
            "rows": [["Dave", -3], ["Carol", -8], ["Bob", -1]],
            "still_in": 4,
            "simultaneous": False,
        },
        # A double kill, ranked by life at death: least negative higher, so the
        # lowest life went out first and takes the worst placement.
        {"rows": [["Dave", -1], ["Carol", -9]], "still_in": 4, "simultaneous": True},
        # Identical life totals are a genuine tie, and a tie takes the BEST
        # placement of the block it occupies: both 3rd, nobody 4th.
        {"rows": [["Dave", -5], ["Carol", -5]], "still_in": 4, "simultaneous": True},
        # Three tied over 2nd, 3rd and 4th all finish 2nd.
        {
            "rows": [["Dave", 0], ["Carol", 0], ["Bob", 0]],
            "still_in": 4,
            "simultaneous": True,
        },
        # A tie inside a larger simultaneous block.
        {
            "rows": [["Dave", -5], ["Carol", -5], ["Bob", -1]],
            "still_in": 4,
            "simultaneous": True,
        },
        # Positive life: a game called on time, ranked by current life.
        {"rows": [["Dave", 12], ["Carol", 3]], "still_in": 3, "simultaneous": True},
        # A smaller table, so the placements start lower.
        {"rows": [["Bob", -2]], "still_in": 2, "simultaneous": False},
        # An empty list has to be survivable.
        {"rows": [], "still_in": 4, "simultaneous": False},
    ]
    out = []
    for c in cases:
        rows = [(name, life) for name, life in c["rows"]]
        places = _finishing_order(rows, c["still_in"], c["simultaneous"])
        out.append({**c, "places": places})
    return out


def _prompts() -> list[dict]:
    cases = [
        # Nothing credited, nothing outstanding.
        {"out": {}, "credits": {}, "just": 0},
        # One kill credited, nobody recorded out yet: one row due.
        {"out": {}, "credits": {("Alice", 1): 1}, "just": 0},
        # Two credited over two turns.
        {"out": {}, "credits": {("Alice", 1): 1, ("Bob", 2): 1}, "just": 0},
        # One credited, one already recorded out: nothing outstanding.
        {"out": {"Dave": 4}, "credits": {("Alice", 1): 1}, "just": 0},
        # The winner holds a placement without having gone out, so they must
        # not count as a recorded death: otherwise the last elimination of
        # every game is hidden.
        {"out": {"Dave": 4, "Carol": 3, "Alice": 1}, "credits": {("Alice", 1): 3}, "just": 0},
        # More credited than there are players left: capped.
        {"out": {}, "credits": {("Alice", 1): 9}, "just": 0},
        # A death nobody was credited for can cancel a kill that IS
        # outstanding, so the turn that credits it raises the rows itself.
        {"out": {"Dave": 4}, "credits": {("Alice", 1): 1}, "just": 1},
        # just_credited is a floor, not an override.
        {"out": {}, "credits": {("Alice", 1): 3}, "just": 1},
        # A table of three, two already out: one left, so no rows.
        {"out": {"Dave": 3, "Carol": 2}, "credits": {("Alice", 1): 2}, "just": 0},
    ]
    out = []
    for c in cases:
        grid = {k: FakeTurn(v) for k, v in c["credits"].items()}
        prompt = _elimination_prompt(TABLE, c["out"], grid, POINTS, c["just"])
        out.append(
            {
                "seating": TABLE,
                "out": c["out"],
                "credits": [[list(k), v] for k, v in c["credits"].items()],
                "just_credited": c["just"],
                "deaths_due": prompt["deaths_due"],
                "elimination_rows": prompt["elimination_rows"],
                "elimination_candidates": prompt["elimination_candidates"],
                "winner_row": prompt["winner_row"],
            }
        )
    return out


def _next_ups() -> list[dict]:
    cases = [
        # Fresh table, nothing played.
        {"out": [], "entered": [], "played": 0},
        # Seat 1 has entered round 1, so seat 2 is next.
        {"out": [], "entered": [["Alice", 1]], "played": 1},
        # The whole round is in: the next round starts at seat 1.
        {
            "out": [],
            "entered": [["Alice", 1], ["Bob", 1], ["Carol", 1], ["Dave", 1]],
            "played": 1,
        },
        # A player out is skipped.
        {"out": ["Alice"], "entered": [], "played": 1},
        {"out": ["Alice", "Bob"], "entered": [["Carol", 2]], "played": 2},
        # Everybody out: fall back to the seating rather than returning nobody.
        {"out": ["Alice", "Bob", "Carol", "Dave"], "entered": [], "played": 3},
    ]
    out = []
    for c in cases:
        player, round_no = _next_up(
            TABLE, set(c["out"]), {(n, r) for n, r in c["entered"]}, c["played"]
        )
        out.append({**c, "player": player, "round_no": round_no})
    return out


def _seat_afters() -> list[dict]:
    cases = [
        {"out": [], "player": "Alice", "round_no": 1},
        {"out": [], "player": "Dave", "round_no": 1},
        {"out": ["Bob"], "player": "Alice", "round_no": 2},
        {"out": ["Bob", "Carol"], "player": "Alice", "round_no": 2},
        # Everyone else out: the lap comes back round to the same player.
        {"out": ["Bob", "Carol", "Dave"], "player": "Alice", "round_no": 5},
        # Passing the last seat starts the next round.
        {"out": ["Alice"], "player": "Dave", "round_no": 3},
    ]
    out = []
    for c in cases:
        player, round_no = _seat_after(TABLE, set(c["out"]), c["player"], c["round_no"])
        out.append({**c, "next_player": player, "next_round": round_no})
    return out


def _pod_sizes() -> list[dict]:
    @dataclass
    class FakeEvent:
        pod_size: int | None

    cases = [(None, [1, 2, 3, 4]), (4, [1, 2, 3, 4]), (2, [1, 2, 3, 4]), (None, [1, 2])]
    return [
        {
            "pod_size": size,
            "placements": places,
            "expected": _expected_pod_size(FakeEvent(size), places),
        }
        for size, places in cases
    ]


def build() -> dict:
    return {
        "note": "Generated by scripts/entry_rules_fixture.py from app/routes/entry.py.",
        "placement_points": {str(k): v for k, v in POINTS.items()},
        "table": TABLE,
        "ordinals": _ordinals(),
        "placement_labels": _placement_labels(),
        "finishing_orders": _finishing_orders(),
        "elimination_prompts": _prompts(),
        "next_up": _next_ups(),
        "seat_after": _seat_afters(),
        "pod_sizes": _pod_sizes(),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    args = ap.parse_args()

    fresh = json.dumps(build(), indent=1, sort_keys=True) + "\n"
    if args.write:
        FIXTURE.write_text(fresh)
        print(f"wrote {FIXTURE.relative_to(REPO)}")
        return 0
    if not FIXTURE.exists():
        print(f"{FIXTURE.relative_to(REPO)} is missing", file=sys.stderr)
        return 1
    if FIXTURE.read_text() != fresh:
        print(
            f"{FIXTURE.relative_to(REPO)} is stale.\nIf the change is intended, run with"
            " --write, then update the Worker until worker/entry-rules.test.ts passes.",
            file=sys.stderr,
        )
        return 1
    data = json.loads(fresh)
    counts = {k: len(v) for k, v in data.items() if isinstance(v, list)}
    print(f"{FIXTURE.relative_to(REPO)} is current: {counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
