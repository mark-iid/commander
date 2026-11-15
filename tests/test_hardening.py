"""Regressions for the bug-scan fixes that have no natural home elsewhere.

Config memoisation, login-throttle bookkeeping, placement ordinals and the
nullable game columns. Each of these is a fix whose failure mode is quiet — a
slow leak, a stale read, a 500 on a page nobody loads until the night is over —
so they get a test rather than a comment.
"""
from __future__ import annotations

import pathlib
import sqlite3
import sys
import time

import pytest
import yaml

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import auth, config  # noqa: E402
from app.repository import SQLiteStorage  # noqa: E402
from app.routes.entry import _ordinal  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
EXAMPLE = (ROOT / "config" / "event.example.yaml").read_text()


# --- config memoisation ------------------------------------------------------

@pytest.fixture(autouse=True)
def _clean_config_cache():
    config.reset_cache()
    yield
    config.reset_cache()


def test_repeated_loads_parse_the_file_once(tmp_path, monkeypatch):
    cfg = tmp_path / "event.yaml"
    cfg.write_text(EXAMPLE)
    monkeypatch.setenv("EVENT_CONFIG", str(cfg))

    reads = {"n": 0}
    real_read = pathlib.Path.read_text

    def counting(self, *a, **k):
        if self == cfg:
            reads["n"] += 1
        return real_read(self, *a, **k)

    monkeypatch.setattr(pathlib.Path, "read_text", counting)

    # What one page render costs: several load_* helpers over the same document.
    config.load_event()
    config.load_scoring()
    config.load_roster()
    config.load_auth()
    assert reads["n"] == 1


def test_editing_the_config_is_picked_up_without_a_restart(tmp_path, monkeypatch):
    """The reason the cache is keyed on mtime rather than just held forever."""
    cfg = tmp_path / "event.yaml"
    cfg.write_text(EXAMPLE)
    monkeypatch.setenv("EVENT_CONFIG", str(cfg))
    assert config.load_event().games_per_player == 3

    cfg.write_text(EXAMPLE.replace("games_per_player: 3", "games_per_player: 5"))
    assert config.load_event().games_per_player == 5


def test_callers_cannot_mutate_the_cached_document(tmp_path, monkeypatch):
    cfg = tmp_path / "event.yaml"
    cfg.write_text(EXAMPLE)
    monkeypatch.setenv("EVENT_CONFIG", str(cfg))

    config.load_raw()["prizes"].clear()
    assert config.load_raw()["prizes"], "a caller emptied the shared document"


def test_a_missing_config_still_raises_rather_than_serving_a_stale_one(tmp_path, monkeypatch):
    cfg = tmp_path / "event.yaml"
    cfg.write_text(EXAMPLE)
    monkeypatch.setenv("EVENT_CONFIG", str(cfg))
    config.load_raw()

    cfg.unlink()
    with pytest.raises(RuntimeError, match="event config not found"):
        config.load_raw()


@pytest.mark.parametrize("broken", [
    "",                                   # truncated mid-save
    "event:\n  name: [unclosed\n",        # not YAML
    EXAMPLE.split("prizes:")[0] + "prizes:\n",   # prizes key with nothing under it
    "- just\n- a list\n",                # YAML, but not a config
])
def test_an_unreadable_edit_keeps_the_last_good_config_in_service(tmp_path, monkeypatch, broken):
    """Config is re-read on every mtime change, so an edit on the box during the
    night is read while it is half-written. That used to 500 every page."""
    cfg = tmp_path / "event.yaml"
    cfg.write_text(EXAMPLE)
    monkeypatch.setenv("EVENT_CONFIG", str(cfg))
    assert config.load_event().games_per_player == 3

    cfg.write_text(broken)
    assert config.load_event().games_per_player == 3
    assert config.load_scoring().prizes

    # And the fix is picked up the moment it lands.
    cfg.write_text(EXAMPLE.replace("games_per_player: 3", "games_per_player: 4"))
    assert config.load_event().games_per_player == 4


def test_an_unreadable_config_at_startup_still_raises(tmp_path, monkeypatch):
    cfg = tmp_path / "event.yaml"
    cfg.write_text("event:\n  name: [unclosed\n")
    monkeypatch.setenv("EVENT_CONFIG", str(cfg))
    with pytest.raises(yaml.YAMLError):
        config.load_raw()


def test_a_roster_with_every_name_commented_out_is_empty(tmp_path, monkeypatch):
    cfg = tmp_path / "event.yaml"
    cfg.write_text(EXAMPLE.replace("  - Alice\n  - Bob\n  - Carol\n  - Dave\n",
                                   "  # - Alice\n"))
    monkeypatch.setenv("EVENT_CONFIG", str(cfg))
    assert config.load_roster() == []


# --- login throttle bookkeeping ----------------------------------------------

class _Req:
    """Just enough Request for client_key()."""

    def __init__(self, headers=None, host="1.2.3.4"):
        self.headers = headers or {}
        self.client = type("C", (), {"host": host})()


def test_the_throttle_key_is_truncated():
    """CF-Connecting-IP is attacker-controlled, so it must not size a dict key."""
    key = auth.client_key(_Req({"CF-Connecting-IP": "X" * 5000}))
    assert len(key) == auth.KEY_MAX


def test_a_rotating_header_cannot_grow_the_throttle_without_bound():
    auth.reset_throttle()
    for i in range(auth.MAX_TRACKED + 500):
        auth.record_failure(f"10.0.{i // 256}.{i % 256}")
    assert len(auth._attempts) <= auth.MAX_TRACKED


def test_an_active_lockout_survives_the_trim():
    """Evicting a lockout would hand back the guesses it took to earn."""
    auth.reset_throttle()
    for _ in range(auth.LOCKOUT_AFTER):
        auth.record_failure("attacker")
    assert auth.locked_for("attacker") > 0

    for i in range(auth.MAX_TRACKED + 500):
        auth.record_failure(f"10.0.{i // 256}.{i % 256}")
    assert auth.locked_for("attacker") > 0


def test_a_quiet_failure_streak_expires(monkeypatch):
    """Four typos across a whole game night must not leave a tracker one typo
    from a lockout they did nothing to earn."""
    auth.reset_throttle()
    now = time.monotonic()
    for _ in range(auth.LOCKOUT_AFTER - 1):
        auth.record_failure("tracker")
    assert auth._attempts["tracker"].fails == auth.LOCKOUT_AFTER - 1

    monkeypatch.setattr(auth.time, "monotonic", lambda: now + auth.ATTEMPT_TTL + 1)
    auth.record_failure("someone-else")
    assert "tracker" not in auth._attempts


# --- placement ordinals ------------------------------------------------------

@pytest.mark.parametrize(
    "n, expected",
    [(1, "1st"), (2, "2nd"), (3, "3rd"), (4, "4th"), (5, "5th"),
     (11, "11th"), (12, "12th"), (13, "13th"), (21, "21st"), (22, "22nd"), (23, "23rd")],
)
def test_ordinals(n, expected):
    assert _ordinal(n) == expected


# --- nullable game columns ---------------------------------------------------

def test_a_game_with_no_pod_or_match_does_not_crash_the_results_sheet(tmp_path):
    """schema.sql leaves pod/round nullable so an ad-hoc game can escape the
    unique index. `int(None)` would be a 500 on /results the day something
    creates one."""
    conn = sqlite3.connect(tmp_path / "t.db")
    conn.row_factory = sqlite3.Row
    conn.executescript((ROOT / "app" / "schema.sql").read_text())
    storage = SQLiteStorage(conn)
    try:
        event_id, _ = storage.ensure_event("E", 3)
        conn.execute(
            "INSERT INTO games (event_id, pod, match_no) VALUES (?, NULL, NULL)", (event_id,)
        )
        conn.execute(
            "INSERT INTO games (event_id, pod, match_no) VALUES (?, ?, ?)", (event_id, "A", 1)
        )
        conn.commit()

        games = storage.games(event_id)
        assert [(g.match_no, g.pod) for g in games] == [(0, "?"), (1, "A")]
    finally:
        conn.close()
