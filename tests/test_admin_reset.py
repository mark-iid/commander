"""The /admin danger zone.

The reset routes get tested as hard as the CLI (tests/test_reset.py) and then
some, because a web surface adds a failure the CLI does not have: something
reaching the destructive endpoint without a human having read the confirmation.
So these tests pin down not just that a reset works, but that arming is inert,
that the confirmation quotes real numbers, and that the gate is the POST.
"""
from __future__ import annotations

import contextlib
import pathlib
import shutil
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import db  # noqa: E402
from app.events import broadcaster  # noqa: E402
from app.main import app  # noqa: E402
from tests.helpers import record_stat  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
PASSCODE = "test-passcode"
SEEDED = ["Alice", "Bob", "Carol", "Dave"]

@pytest.fixture
def tmp(tmp_path, monkeypatch):
    cfg = tmp_path / "event.yaml"
    shutil.copy(ROOT / "config" / "event.example.yaml", cfg)
    monkeypatch.setenv("EVENT_CONFIG", str(cfg))
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("TRACKER_PASSCODE", PASSCODE)
    monkeypatch.setenv("SESSION_SECRET", "0" * 64)
    return tmp_path


@contextlib.contextmanager
def _session():
    db.close_connections()
    with TestClient(app) as c:
        assert c.post("/login", data={"passcode": PASSCODE},
                      follow_redirects=False).status_code == 303
        yield c
    db.close_connections()


@pytest.fixture
def client(tmp):
    with _session() as c:
        yield c


@pytest.fixture
def published(monkeypatch):
    events: list[str] = []

    async def _fake(event: str) -> None:
        events.append(event)

    monkeypatch.setattr(broadcaster, "publish", _fake)
    return events


def _stats():
    return db.get_storage().all_stats(app.state.event_id)


def _finished():
    """Rows for players who actually finished a game.

    all_stats() returns a row per SEATED player now, zeros and all, so counting
    it would count the empty seats at the table too. "Nothing was deleted" means
    the games that were played are still there.
    """
    return [s for s in _stats() if s.placement is not None]


def _roster():
    return db.get_storage().roster(app.state.event_id)


def _record(client, players=("Alice", "Bob")):
    for i, name in enumerate(players, start=1):
        record_stat(client, name, i, combat_dmg_dealt=40, final_life=5)


# --- the panel ---------------------------------------------------------------

def test_admin_page_shows_the_danger_zone(client):
    body = client.get("/admin").text
    assert 'id="danger-zone"' in body
    assert "Clear all results" in body
    assert "Reset everything" in body
    # ...and does not offer a one-click destructive POST anywhere on the page.
    assert 'hx-post="/admin/reset"' not in body


def test_the_idle_panel_reports_what_is_in_the_database(client):
    _record(client)
    body = client.get("/admin/reset").text
    assert "2 stat rows" in body
    assert "1 game" in body
    assert "4 players" in body


# --- arming is inert ---------------------------------------------------------

@pytest.mark.parametrize("scope", ["results", "all"])
def test_arming_deletes_nothing(client, scope):
    """The whole design rests on this: a GET may be prefetched, refreshed or
    double-clicked, so it must never be the thing that destroys data."""
    _record(client)
    r = client.get("/admin/reset/confirm", params={"scope": scope})
    assert r.status_code == 200
    assert "Are you sure?" in r.text
    assert len(_finished()) == 2
    assert _roster() == SEEDED


def test_the_confirmation_quotes_the_real_counts(client):
    _record(client, players=("Alice", "Bob", "Carol"))
    body = client.get("/admin/reset/confirm", params={"scope": "results"}).text
    assert "3 stat rows" in body
    assert "roster is kept" in body


def test_the_all_confirmation_names_the_roster_it_will_restore(client):
    body = client.get("/admin/reset/confirm", params={"scope": "all"}).text
    assert "removes all" in body
    assert "Alice, Bob, Carol, Dave" in body


def test_an_unknown_scope_is_refused(client):
    r = client.get("/admin/reset/confirm", params={"scope": "everything"})
    assert r.status_code == 422
    assert "Unknown reset type." in r.text


def test_cancel_returns_the_idle_panel(client):
    body = client.get("/admin/reset").text
    assert "Are you sure?" not in body
    assert "Clear all results" in body


# --- doing it ----------------------------------------------------------------

def test_results_reset_clears_play_and_keeps_the_roster(client, published):
    _record(client)
    r = client.post("/admin/reset", data={"scope": "results"})
    assert r.status_code == 200
    assert _stats() == []
    assert _roster() == SEEDED
    assert "Deleted 2 stat rows across 1 game" in r.text
    assert "stats-updated" in published


def test_all_reset_replaces_a_test_roster_with_the_configured_one(client, published):
    client.post("/admin/players", data={"name": "Fake McTestface", "commander": ""})
    _record(client, players=("Fake McTestface",))

    r = client.post("/admin/reset", data={"scope": "all"})
    assert r.status_code == 200
    assert _stats() == []
    assert _roster() == SEEDED
    assert "roster-changed" in published


def test_all_reset_keeps_the_event_so_saving_still_works(client):
    """app.state.event_id is cached for the process lifetime. If a reset
    invalidated it, every save would fail until someone restarted the service —
    and the tracker would see an unswapped panel, not an error."""
    before = app.state.event_id
    _record(client)

    client.post("/admin/reset", data={"scope": "all"})

    assert app.state.event_id == before
    _record(client)                      # the proof: entry still works, unrestarted
    assert len(_finished()) == 2


def test_a_reset_post_with_an_unknown_scope_deletes_nothing(client):
    _record(client)
    r = client.post("/admin/reset", data={"scope": "drop-tables"})
    assert r.status_code == 422
    assert len(_finished()) == 2


def test_a_reset_post_with_no_scope_deletes_nothing(client):
    _record(client)
    assert client.post("/admin/reset", data={}).status_code == 422
    assert len(_finished()) == 2


def test_the_response_refreshes_the_roster_out_of_band(client):
    """The POST targets #danger-zone, so without an OOB swap the roster table
    would still show the players a scope=all reset just deleted."""
    client.post("/admin/players", data={"name": "Fake McTestface", "commander": ""})
    r = client.post("/admin/reset", data={"scope": "all"})
    assert 'hx-swap-oob="true"' in r.text
    assert 'id="roster"' in r.text
    assert "Fake McTestface" not in r.text


def test_a_backup_is_written_before_deleting(client, tmp):
    _record(client)
    r = client.post("/admin/reset", data={"scope": "results"})

    backups = sorted((tmp / "backups").glob("test.db.*"))
    assert len(backups) == 1
    assert backups[0].name in r.text          # the operator is told where it went

    import sqlite3
    conn = sqlite3.connect(backups[0])
    try:
        assert conn.execute("SELECT count(*) FROM game_player_stats").fetchone()[0] == 2
    finally:
        conn.close()


def test_nothing_is_deleted_if_the_backup_cannot_be_written(client, tmp, monkeypatch):
    """A reset that destroys data after failing to back it up is the one outcome
    with no way back."""
    from app.routes import admin

    def _boom() -> pathlib.Path:
        raise db.BackupFailed("no space left on device")

    monkeypatch.setattr(admin, "backup_database", _boom)
    _record(client)

    r = client.post("/admin/reset", data={"scope": "results"})
    assert r.status_code == 422
    assert "nothing was deleted" in r.text
    assert len(_finished()) == 2


def test_a_sqlite_level_backup_failure_is_reported_not_a_500(client, tmp, monkeypatch):
    """The regression that made the guard worth having.

    sqlite3.Error is not an OSError subclass, so a corrupt or unreadable
    database used to raise straight past `except OSError` and 500. htmx does not
    swap 5xx, so the operator saw a Reset button that did nothing at all — no
    backup, no reset, no message.
    """
    import sqlite3

    from app.routes import admin

    def _boom() -> pathlib.Path:
        raise db.BackupFailed(str(sqlite3.DatabaseError("file is not a database")))

    monkeypatch.setattr(admin, "backup_database", _boom)
    _record(client)

    r = client.post("/admin/reset", data={"scope": "results"})
    assert r.status_code == 422
    assert "nothing was deleted" in r.text
    assert "file is not a database" in r.text
    assert len(_finished()) == 2


def test_backup_database_translates_sqlite_errors_and_closes_its_handles(tmp_path, monkeypatch):
    """The translation and the cleanup, at the source rather than through a mock."""
    import sqlite3

    corrupt = tmp_path / "corrupt.db"
    corrupt.write_bytes(b"this is not a sqlite database" * 100)
    monkeypatch.setenv("DB_PATH", str(corrupt))

    opened: list[sqlite3.Connection] = []
    real_connect = sqlite3.connect

    def spy(*args, **kwargs):
        conn = real_connect(*args, **kwargs)
        opened.append(conn)
        return conn

    monkeypatch.setattr(db.sqlite3, "connect", spy)

    with pytest.raises(db.BackupFailed) as exc:
        db.backup_database()
    assert "not a database" in str(exc.value)

    # Every connection the backup opened is closed, including the destination —
    # `with sqlite3.connect(...)` commits but does not close, so it used to leak
    # one handle per reset.
    assert opened, "the backup opened no connections at all"
    for conn in opened:
        with pytest.raises(sqlite3.ProgrammingError):
            conn.execute("SELECT 1")


# --- auth --------------------------------------------------------------------

@pytest.mark.parametrize(
    "method, path",
    [("get", "/admin/reset"), ("get", "/admin/reset/confirm"), ("post", "/admin/reset")],
)
def test_reset_endpoints_are_behind_the_passcode(tmp, method, path):
    db.close_connections()
    with TestClient(app) as anon:
        r = getattr(anon, method)(path, follow_redirects=False)
        assert r.status_code in (302, 303), f"{path} answered {r.status_code} to a stranger"
        assert "/login" in r.headers["location"]
    db.close_connections()
