#!/usr/bin/env python3
"""Record what the FastAPI app exports, so the Worker can be held to it.

Phase 2 of ADR 0003 reimplements /results.csv and /results/turns.csv in
TypeScript. Both are the take-home record of a night, and a column that shifted
or a row that sorted differently would not be noticed until somebody read the
sheet months later. So the Python app's own output over the golden fixture is
captured here, and worker/routes/results.test.ts requires the Worker to produce
it byte for byte.

    python3 scripts/results_csv_fixture.py --check    # regenerate and compare
    python3 scripts/results_csv_fixture.py --write    # regenerate and save

`--check` runs in the pytest suite (tests/test_results_csv_fixture.py), so a
change to the Python exports turns it red; adopting the change with --write
then turns the Worker's test red until it matches again. The two cannot drift.

Only the bodies are captured. The filenames carry a timestamp and the event's
timezone, which are tested separately.

Read and written with newline="" throughout. The exports are CRLF, which is
what csv.writer emits and what a spreadsheet expects, and the default text mode
translates on the way in: a plain read_text() hands back LF and then compares
unequal to a fresh capture that still has its CRLF. That looks exactly like a
stale fixture and is not one.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import pathlib
import sqlite3
import sys
import tempfile

import yaml

REPO = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

FIXTURE = REPO / "shared" / "fixtures" / "fall-2026.json"
EXPORTS = {
    "results": REPO / "shared" / "fixtures" / "fall-2026-results.csv",
    "turns": REPO / "shared" / "fixtures" / "fall-2026-turns.csv",
}
PASSCODE = "fixture-passcode"

# Foreign keys are on, so parents first.
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


@contextlib.contextmanager
def _app_over_fixture(fixture: dict):
    """The real FastAPI app, serving the fixture's night from a temp database."""
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = pathlib.Path(tmp)
        db_path = tmpdir / "fixture.db"

        conn = sqlite3.connect(db_path)
        try:
            conn.executescript((REPO / "app" / "schema.sql").read_text())
            for table in TABLES:
                for row in fixture["raw"][table]:
                    cols = sorted(row)
                    conn.execute(
                        f"INSERT INTO {table} ({','.join(cols)})"
                        f" VALUES ({','.join('?' * len(cols))})",
                        [row[c] for c in cols],
                    )
            conn.commit()
        finally:
            conn.close()

        # The event name has to match the fixture's, or startup creates a
        # second event and the export comes back empty.
        cfg = {
            "event": {
                "name": fixture["raw"]["events"][0]["name"],
                "games_per_player": fixture["raw"]["events"][0]["games_per_player"],
                "pods": ["A", "B"],
            },
            "auth": {"protect_display": False, "session_hours": 12, "secure_cookies": False},
            "scoring": fixture["scoring"],
            "roster": fixture["roster"],
            "prizes": fixture["prizes"],
        }
        cfg_path = tmpdir / "event.yaml"
        cfg_path.write_text(yaml.safe_dump(cfg))

        os.environ["EVENT_CONFIG"] = str(cfg_path)
        os.environ["DB_PATH"] = str(db_path)
        os.environ["TRACKER_PASSCODE"] = PASSCODE
        os.environ["SESSION_SECRET"] = "0" * 64

        from fastapi.testclient import TestClient

        from app import db as app_db
        from app.main import app

        app_db.close_connections()
        with TestClient(app) as client:
            assert (
                client.post(
                    "/login", data={"passcode": PASSCODE}, follow_redirects=False
                ).status_code
                == 303
            )
            yield client
        app_db.close_connections()


def recapture() -> dict[str, str]:
    fixture = json.loads(FIXTURE.read_text())
    with _app_over_fixture(fixture) as client:
        out = {}
        for kind, url in (("results", "/results.csv"), ("turns", "/results/turns.csv")):
            response = client.get(url)
            assert response.status_code == 200, response.text[:400]
            out[kind] = response.text
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="compare, exit 1 on a mismatch")
    mode.add_argument("--write", action="store_true", help="recapture and save")
    args = ap.parse_args()

    fresh = recapture()
    if args.write:
        for kind, path in EXPORTS.items():
            path.write_text(fresh[kind], newline="")
            print(f"wrote {path.relative_to(REPO)} ({len(fresh[kind].splitlines())} lines)")
        return 0

    stale = False
    for kind, path in EXPORTS.items():
        if not path.exists():
            print(f"{path.relative_to(REPO)} is missing", file=sys.stderr)
            stale = True
        elif path.read_text(newline="") != fresh[kind]:
            print(f"{path.relative_to(REPO)} is stale", file=sys.stderr)
            stale = True
    if stale:
        print(
            "\nIf the change is intended, run with --write, then update the Worker"
            "\nuntil worker/routes/results.test.ts passes again.",
            file=sys.stderr,
        )
        return 1
    for kind, path in EXPORTS.items():
        print(f"{path.relative_to(REPO)} is current ({len(fresh[kind].splitlines())} lines)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
