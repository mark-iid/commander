#!/usr/bin/env python3
"""Keep shared/fixtures/fall-2026.json's expected results honest.

The fixture holds the real Fall 2026 night three times over: `raw` (the rows as
stored), `derived` (what app/repository.py aggregates them into) and `expected`
(what app/scoring.py makes of that). The TypeScript port is tested against the
last two in shared/scoring.golden.test.ts, which only means anything while they
are genuinely Python's output.

So Python stays the reference implementation and this script is the link:

    python3 scripts/fixture_expected.py --check    # recompute and compare
    python3 scripts/fixture_expected.py --write    # recompute and save

`--check` runs in the pytest suite (tests/test_fixture.py), so a change to the
scoring engine or to the aggregation SQL turns it red. Regenerating with
--write is the deliberate second step, and it will flip the TypeScript golden
test red in turn until that side is brought along. Two engines cannot drift
apart quietly; one of the two suites always notices.

Nothing here touches a real deployment or a real roster: the fixture's names are
pseudonyms, applied in the original roster order because roster order is the
scoring engine's last-resort tiebreaker.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sqlite3
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

FIXTURE = REPO / "shared" / "fixtures" / "fall-2026.json"

# Insertion order, not the file's alphabetical order: foreign keys are on, so a
# child row inserted before its parent fails the constraint rather than the test.
TABLES = (
    "events",
    "players",
    "games",
    "game_seats",
    "turn_stats",
    "turn_damage",
    "game_player_stats",
    "match_commanders",
)


def _load_into(db_path: str, raw: dict[str, list[dict]]) -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript((REPO / "app" / "schema.sql").read_text())
        for table in TABLES:
            for row in raw[table]:
                cols = sorted(row)
                conn.execute(
                    f"INSERT INTO {table} ({','.join(cols)})"
                    f" VALUES ({','.join('?' * len(cols))})",
                    [row[c] for c in cols],
                )
        conn.commit()
    finally:
        conn.close()


def recompute(fixture: dict) -> dict:
    """The `derived` and `expected` halves, rebuilt from `raw` by the real app."""
    from app.repository import SQLiteStorage
    from app.scoring import ScoringConfig, build_standings, leaderboard, ranked_standings

    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    os.unlink(path)
    try:
        _load_into(path, fixture["raw"])
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        try:
            storage = SQLiteStorage(conn)
            event_id = fixture["raw"]["events"][0]["event_id"]
            # Sorted so the file is stable across runs and diffs cleanly.
            stats = sorted(storage.all_stats(event_id), key=lambda s: (s.game_id, s.player))
        finally:
            conn.close()
    finally:
        pathlib.Path(path).unlink(missing_ok=True)

    config = ScoringConfig.from_dict(
        {"scoring": fixture["scoring"], "prizes": fixture["prizes"]}
    )
    roster = fixture["roster"]
    standings = build_standings(stats, config, roster)
    return {
        "derived": [vars(s) for s in stats],
        "expected": {
            "standings": [vars(st) for st in standings],
            "ranked": [[rank, st.player] for rank, st in ranked_standings(standings)],
            "prizes": [vars(p) for p in leaderboard(stats, config, roster)],
        },
    }


def _serialise(fixture: dict) -> str:
    return json.dumps(fixture, indent=1, sort_keys=True) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="compare, exit 1 on a mismatch")
    mode.add_argument("--write", action="store_true", help="recompute and save")
    args = ap.parse_args()

    fixture = json.loads(FIXTURE.read_text())
    fresh = recompute(fixture)
    updated = {**fixture, **fresh}

    if args.write:
        FIXTURE.write_text(_serialise(updated))
        print(f"wrote {FIXTURE.relative_to(REPO)}")
        return 0

    if _serialise(updated) == _serialise(fixture):
        prizes = fixture["expected"]["prizes"]
        print(
            f"{FIXTURE.relative_to(REPO)} is current: "
            f"{len(fixture['roster'])} players, {len(fixture['derived'])} game rows, "
            f"{len(prizes)} prizes"
        )
        return 0

    print(f"{FIXTURE.relative_to(REPO)} is stale.\n", file=sys.stderr)
    for half in ("derived", "expected"):
        if fresh[half] != fixture[half]:
            print(f"  {half} differs from what the app now computes", file=sys.stderr)
    was = {p["key"]: (p["winner"], p["value"]) for p in fixture["expected"]["prizes"]}
    now = {p["key"]: (p["winner"], p["value"]) for p in fresh["expected"]["prizes"]}
    for key in was:
        if was[key] != now.get(key):
            print(f"  prize {key}: {was[key]} -> {now.get(key)}", file=sys.stderr)
    print(
        "\nIf the change is intended, run with --write, then update the"
        "\nTypeScript engine until shared/scoring.golden.test.ts passes again.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
