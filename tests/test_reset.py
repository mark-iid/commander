"""Reset: the repository primitives and the scripts/reset.py CLI.

A reset tool gets tested harder than most code because both of its failure modes
are silent. Deleting too much loses an evening's scores; deleting nothing while
reporting success is worse, because the operator believes they have a clean slate
and enters a real event on top of test data.
"""
from __future__ import annotations

import pathlib
import shutil
import sqlite3
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import db  # noqa: E402
from app.models import FinalStat, TurnStat  # noqa: E402
from scripts.reset import load_env_file, main  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]


@pytest.fixture
def env(tmp_path, monkeypatch):
    """A seeded database on disk, wired the way the app wires itself."""
    cfg = tmp_path / "event.yaml"
    shutil.copy(ROOT / "config" / "event.example.yaml", cfg)
    monkeypatch.setenv("EVENT_CONFIG", str(cfg))
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    db.close_connections()

    db.init_db()
    storage = db.get_storage()
    event_id, _ = storage.ensure_event("Fall 2026 Battle of the Commanders", 3)
    storage.sync_roster(event_id, ["Alice", "Bob", "Carol", "Dave"])
    yield tmp_path, storage, event_id
    db.close_connections()


def finished(storage, event_id):
    """Rows for players who actually finished. all_stats() returns a row per
    SEATED player now, so it counts the empty seats at the table too."""
    return [s for s in storage.all_stats(event_id) if s.placement is not None]


def record(storage, event_id, *, pod="A", round_=1, players=("Alice", "Bob")):
    """Seat a table and play one turn each. `round_` is the match number.

    The table is always seated with the full roster -- a pod is four players
    even when a test only cares about two of them -- and `players` is who
    actually recorded a turn.
    """
    game_id = storage.get_or_create_game(event_id, pod, round_)
    # From the event's own roster: the scoped test runs a second event whose
    # players are different, and seating names it does not have would fail.
    seating = storage.roster(event_id)
    storage.seat_players(game_id, seating)
    for i, name in enumerate(players, start=1):
        # A one-player event (the scoped test runs one) has nobody to hit.
        target = next((n for n in seating if n != name), None)
        damage = {target: 10 * i} if target else {}
        storage.save_turn(game_id, name, TurnStat(1, damage=damage))
        storage.save_final(game_id, name, FinalStat(placement=i))
    return game_id


# --- repository primitives ---------------------------------------------------

def test_clear_results_removes_play_but_keeps_the_roster(env):
    _, storage, event_id = env
    record(storage, event_id)
    record(storage, event_id, pod="B", round_=2, players=("Carol",))

    games, rows = storage.clear_results(event_id)
    assert (games, rows) == (2, 3)
    assert storage.all_stats(event_id) == []
    assert storage.find_game(event_id, "A", 1) is None
    assert storage.roster(event_id) == ["Alice", "Bob", "Carol", "Dave"]


def test_clear_results_reports_zero_when_there_is_nothing_to_clear(env):
    _, storage, event_id = env
    assert storage.clear_results(event_id) == (0, 0)


def test_clear_results_is_scoped_to_one_event(env):
    """Two events share a database. Resetting one must not touch the other."""
    _, storage, event_id = env
    other_id, _ = storage.ensure_event("Some Other Night", 3)
    storage.sync_roster(other_id, ["Erin"])
    record(storage, event_id)
    other_game = record(storage, other_id, players=("Erin",))

    storage.clear_results(event_id)
    assert storage.all_stats(event_id) == []
    assert len(storage.stats_for_game(other_game)) == 1
    assert storage.roster(other_id) == ["Erin"]


def test_clear_roster_removes_players_and_their_stats(env):
    _, storage, event_id = env
    record(storage, event_id)

    assert storage.clear_roster(event_id) == 4
    assert storage.roster(event_id) == []
    assert storage.all_stats(event_id) == []


def test_clear_roster_is_scoped_to_one_event(env):
    _, storage, event_id = env
    other_id, _ = storage.ensure_event("Some Other Night", 3)
    storage.sync_roster(other_id, ["Erin"])

    storage.clear_roster(event_id)
    assert storage.roster(other_id) == ["Erin"]


# --- the CLI -----------------------------------------------------------------

def run(tmp_path, *argv):
    """Always pass an env-file that does not exist: the developer's own .env
    must not decide which database the test suite wipes."""
    return main([*argv, "--env-file", str(tmp_path / "absent.env")])


def test_status_only_run_changes_nothing(env, capsys):
    tmp_path, storage, event_id = env
    record(storage, event_id)

    assert run(tmp_path) == 0
    assert len(finished(storage, event_id)) == 2
    out = capsys.readouterr().out
    assert "2 stat row(s)" in out
    assert "4 player(s)" in out


def test_without_yes_it_only_describes_the_plan(env, capsys):
    tmp_path, storage, event_id = env
    record(storage, event_id)

    assert run(tmp_path, "--results") == 0
    assert len(finished(storage, event_id)) == 2
    assert "Would delete" in capsys.readouterr().out


def test_results_reset_clears_play_and_keeps_players(env):
    tmp_path, storage, event_id = env
    record(storage, event_id)

    assert run(tmp_path, "--results", "--yes") == 0
    assert storage.all_stats(event_id) == []
    assert storage.roster(event_id) == ["Alice", "Bob", "Carol", "Dave"]


def test_all_reset_replaces_a_test_roster_with_the_configured_one(env):
    tmp_path, storage, event_id = env
    storage.add_player(event_id, "Fake McTestface", None)
    record(storage, event_id, players=("Fake McTestface",))

    assert run(tmp_path, "--all", "--yes") == 0
    assert storage.all_stats(event_id) == []
    # Back to exactly what config seeds — the test player is gone.
    assert storage.roster(event_id) == ["Alice", "Bob", "Carol", "Dave"]


def test_all_reset_keeps_the_event_so_a_running_server_stays_valid(env):
    """The server caches event_id in app.state. If a reset invalidated it, every
    save would fail until someone restarted the service."""
    tmp_path, storage, event_id = env
    record(storage, event_id)

    run(tmp_path, "--all", "--yes")
    after, created = storage.ensure_event("Fall 2026 Battle of the Commanders", 3)
    assert (after, created) == (event_id, False)
    # and the event is immediately usable again
    record(storage, event_id)
    assert len(finished(storage, event_id)) == 2


def test_the_backup_is_a_readable_database_holding_the_deleted_rows(env):
    tmp_path, storage, event_id = env
    record(storage, event_id)

    run(tmp_path, "--results", "--yes")

    backups = sorted((tmp_path / "backups").glob("test.db.*"))
    assert len(backups) == 1
    conn = sqlite3.connect(backups[0])
    try:
        assert conn.execute("SELECT count(*) FROM game_player_stats").fetchone()[0] == 2
    finally:
        conn.close()


def test_no_backup_skips_it(env):
    tmp_path, storage, event_id = env
    record(storage, event_id)

    run(tmp_path, "--results", "--yes", "--no-backup")
    assert not (tmp_path / "backups").exists()


def test_results_and_all_are_mutually_exclusive(env):
    tmp_path, _, _ = env
    with pytest.raises(SystemExit):
        run(tmp_path, "--results", "--all", "--yes")


# --- env file ----------------------------------------------------------------

def test_env_file_does_not_override_a_variable_already_set(tmp_path, monkeypatch):
    envfile = tmp_path / ".env"
    envfile.write_text('DB_PATH=/from/file/x.db\nEVENT_CONFIG="/from/file/e.yaml"\n# comment\n')
    monkeypatch.setenv("DB_PATH", "/explicit/wins.db")
    monkeypatch.delenv("EVENT_CONFIG", raising=False)

    load_env_file(envfile)

    import os
    assert os.environ["DB_PATH"] == "/explicit/wins.db"
    assert os.environ["EVENT_CONFIG"] == "/from/file/e.yaml"   # quotes stripped


def test_a_missing_env_file_is_not_an_error(tmp_path):
    load_env_file(tmp_path / "nope.env")
