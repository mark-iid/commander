"""The import to D1 must not change a single result.

Phase 1 of ADR 0003 moves the night onto a new schema. The claim that has to
hold is narrow and absolute: the same night, read back out of the new tables,
scores exactly as it did out of the old ones.

So this runs the whole path on the golden fixture -- old schema, exporter, new
schema, aggregation, scoring -- and compares against the results the live app
produced. The same check was run against the real 2026-11-14 database, which
cannot be committed because it has real names in it; this is its CI-safe twin.

The aggregation query is the same text in both schemas, which is why
app/repository.py can read the new tables at all: nothing the query touches was
renamed. See tests/test_aggregate_parity.py.
"""
import json
import pathlib
import sqlite3
import sys

import pytest
import yaml

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.repository import SQLiteStorage  # noqa: E402
from app.scoring import (  # noqa: E402
    ScoringConfig,
    build_standings,
    leaderboard,
    ranked_standings,
)
from scripts.export_for_d1 import build, lit  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parents[1]
FIXTURE = json.loads((REPO / "shared" / "fixtures" / "fall-2026.json").read_text())

# Foreign keys are on, so parents first.
ORDER = (
    "events",
    "players",
    "games",
    "game_seats",
    "turn_stats",
    "turn_damage",
    "game_player_stats",
    "match_commanders",
)


def _old_schema_db(path: pathlib.Path, raw: dict) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.executescript((REPO / "app" / "schema.sql").read_text())
        for table in ORDER:
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


def _config_file(path: pathlib.Path, overrides: dict | None = None) -> pathlib.Path:
    cfg = {
        "event": {
            "name": FIXTURE["raw"]["events"][0]["name"],
            "games_per_player": 3,
            "pods": ["A", "B"],
        },
        "scoring": dict(FIXTURE["scoring"]),
        "prizes": FIXTURE["prizes"],
    }
    if overrides:
        for section, values in overrides.items():
            cfg[section] = {**cfg[section], **values} if isinstance(values, dict) else values
    path.write_text(yaml.safe_dump(cfg))
    return path


def _new_schema_db(path: pathlib.Path, sql: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript((REPO / "migrations" / "0001_initial.sql").read_text())
    conn.executescript(sql)
    conn.commit()
    conn.row_factory = sqlite3.Row
    return conn


@pytest.fixture
def migrated(tmp_path, monkeypatch) -> sqlite3.Connection:
    """The fixture's night, carried through the exporter onto the new schema."""
    old = tmp_path / "old.db"
    _old_schema_db(old, FIXTURE["raw"])
    sql = "\n".join(build(str(old), str(_config_file(tmp_path / "event.yaml"))))
    monkeypatch.setenv("DB_PATH", str(tmp_path / "new.db"))
    conn = _new_schema_db(tmp_path / "new.db", sql)
    yield conn
    conn.close()


def _config_from_db(conn: sqlite3.Connection, event_id: int) -> tuple[ScoringConfig, list[str]]:
    """Read the scoring config back out of the tables that replaced the YAML."""
    roster = [
        r["name"]
        for r in conn.execute(
            "SELECT name FROM players WHERE event_id = ? ORDER BY roster_position", (event_id,)
        )
    ]
    cfg = {
        "scoring": {
            "placement_points": {
                r["placement"]: r["points"]
                for r in conn.execute(
                    "SELECT placement, points FROM placement_points WHERE event_id = ?",
                    (event_id,),
                )
            },
            "total_damage_fields": [
                r["field"]
                for r in conn.execute(
                    "SELECT field FROM total_damage_fields WHERE event_id = ?"
                    " ORDER BY position",
                    (event_id,),
                )
            ],
            "prize_ineligible": [
                r["name"]
                for r in conn.execute(
                    "SELECT name FROM players WHERE event_id = ? AND prize_eligible = 0"
                    " ORDER BY roster_position",
                    (event_id,),
                )
            ],
        },
        "prizes": [
            {
                "key": r["key"],
                "name": r["name"],
                "metric": r["metric"],
                "agg": r["agg"],
                "scope": r["scope"],
                "tiebreak": (
                    {
                        "field": r["tiebreak_field"],
                        "direction": r["tiebreak_direction"],
                        "scope": r["tiebreak_scope"],
                    }
                    if r["tiebreak_field"]
                    else None
                ),
            }
            for r in conn.execute(
                "SELECT * FROM prizes WHERE event_id = ? ORDER BY position", (event_id,)
            )
        ],
    }
    return ScoringConfig.from_dict(cfg), roster


def _active_event(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT event_id FROM active_event WHERE singleton = 1").fetchone()[0]


def test_the_night_scores_identically_on_the_new_schema(migrated):
    event_id = _active_event(migrated)
    config, roster = _config_from_db(migrated, event_id)
    stats = sorted(
        SQLiteStorage(migrated).all_stats(event_id), key=lambda s: (s.game_id, s.player)
    )

    assert [vars(s) for s in stats] == FIXTURE["derived"]
    standings = build_standings(stats, config, roster)
    assert [vars(st) for st in standings] == FIXTURE["expected"]["standings"]
    assert [[rank, st.player] for rank, st in ranked_standings(standings)] == (
        FIXTURE["expected"]["ranked"]
    )
    assert [vars(p) for p in leaderboard(stats, config, roster)] == FIXTURE["expected"]["prizes"]


def test_the_roster_keeps_its_order_and_the_organiser_keeps_their_flag(migrated):
    event_id = _active_event(migrated)
    _, roster = _config_from_db(migrated, event_id)
    # Roster order is the last-resort tiebreaker, so this is not cosmetic.
    assert roster == FIXTURE["roster"]
    ineligible = [
        r["name"]
        for r in migrated.execute(
            "SELECT name FROM players WHERE prize_eligible = 0 ORDER BY roster_position"
        )
    ]
    assert ineligible == FIXTURE["scoring"]["prize_ineligible"]


def test_pods_become_rows(migrated):
    pods = [
        r["label"]
        for r in migrated.execute("SELECT label FROM pods ORDER BY position")
    ]
    assert pods == ["A", "B"]
    # pod_size was absent from the config and defaults to the placement tiers.
    assert migrated.execute("SELECT pod_size FROM events").fetchone()[0] == 4


def test_an_ineligible_name_matching_nobody_is_refused(tmp_path):
    """The silent version of this mistake is the organiser winning prizes."""
    old = tmp_path / "old.db"
    _old_schema_db(old, FIXTURE["raw"])
    cfg = _config_file(
        tmp_path / "event.yaml", {"scoring": {"prize_ineligible": ["Nobody At All"]}}
    )
    with pytest.raises(SystemExit) as e:
        build(str(old), str(cfg))
    assert "Nobody At All" in str(e.value)


def test_a_lone_ineligible_name_without_brackets_still_works(tmp_path):
    old = tmp_path / "old.db"
    _old_schema_db(old, FIXTURE["raw"])
    cfg = _config_file(tmp_path / "event.yaml", {"scoring": {"prize_ineligible": "Alice"}})
    sql = "\n".join(build(str(old), str(cfg)))
    conn = _new_schema_db(tmp_path / "new.db", sql)
    try:
        ineligible = [
            r["name"] for r in conn.execute("SELECT name FROM players WHERE prize_eligible = 0")
        ]
    finally:
        conn.close()
    assert ineligible == ["Alice"]


def test_an_apostrophe_in_a_name_survives(tmp_path):
    """Deck names are free text and people own apostrophes. The fixture's own
    decks use a typographic quote, so plain ' is not covered by the data."""
    raw = json.loads(json.dumps(FIXTURE["raw"]))
    raw["match_commanders"][0]["commander"] = "Jim's O'Brien; DROP TABLE players--"
    old = tmp_path / "old.db"
    _old_schema_db(old, raw)
    sql = "\n".join(build(str(old), str(_config_file(tmp_path / "event.yaml"))))
    conn = _new_schema_db(tmp_path / "new.db", sql)
    try:
        assert conn.execute(
            "SELECT commander FROM match_commanders WHERE commander LIKE 'Jim%'"
        ).fetchone()[0] == "Jim's O'Brien; DROP TABLE players--"
        # The table is still there, which is the other half of the point.
        assert conn.execute("SELECT COUNT(*) FROM players").fetchone()[0] == 8
    finally:
        conn.close()


def test_a_database_with_several_events_is_refused(tmp_path):
    old = tmp_path / "old.db"
    _old_schema_db(old, FIXTURE["raw"])
    conn = sqlite3.connect(old)
    conn.execute("INSERT INTO events (name, games_per_player) VALUES ('Another night', 3)")
    conn.commit()
    conn.close()
    with pytest.raises(SystemExit) as e:
        build(str(old), str(_config_file(tmp_path / "event.yaml")))
    assert "found 2" in str(e.value)


def test_unexpected_types_are_refused_rather_than_stringified():
    assert lit(None) == "NULL"
    assert lit(7) == "7"
    assert lit("it's") == "'it''s'"
    with pytest.raises(TypeError):
        lit(1.5)
    with pytest.raises(TypeError):
        lit(b"bytes")
