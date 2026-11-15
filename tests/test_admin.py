"""Admin roster surface: listing, add, rename, commander, delete.

Same shape as tests/test_entry.py — a fresh SQLite file and a copy of the
example config per test, seeded through the app's own startup path, with a
signed-in client because /admin is gated.
"""
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
from app.repository import SQLiteStorage  # noqa: E402
from tests.helpers import record_final, record_stat, record_turn, seat_table  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]

PASSCODE = "test-passcode"

# config/event.example.yaml ships with these, in this order.
SEEDED = ["Alice", "Bob", "Carol", "Dave"]

@pytest.fixture
def env(tmp_path, monkeypatch):
    """Config + DB + secrets for one test. Separate from `client` so a test can
    start the app twice against the same database."""
    cfg = tmp_path / "event.yaml"
    shutil.copy(ROOT / "config" / "event.example.yaml", cfg)
    monkeypatch.setenv("EVENT_CONFIG", str(cfg))
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("TRACKER_PASSCODE", PASSCODE)
    monkeypatch.setenv("SESSION_SECRET", "0" * 64)
    return cfg


@contextlib.contextmanager
def _session():
    """One app lifecycle, with a signed-in client."""
    db.close_connections()
    with TestClient(app) as c:
        assert c.post(
            "/login", data={"passcode": PASSCODE}, follow_redirects=False
        ).status_code == 303
        yield c
    db.close_connections()


@pytest.fixture
def client(env):
    with _session() as c:
        yield c


@pytest.fixture
def published(monkeypatch):
    """Captures event-bus publishes. "roster-changed" is load-bearing — the
    projector only re-renders when a mutation publishes."""
    events: list[str] = []

    async def _fake(event: str) -> None:
        events.append(event)

    monkeypatch.setattr(broadcaster, "publish", _fake)
    return events


def _names(client) -> list[str]:
    return db.get_storage().roster(app.state.event_id)


def _player_id(client, name: str) -> int:
    return next(p.player_id for p in db.get_storage().players(app.state.event_id)
                if p.name == name)


def _commander(client, name: str) -> str | None:
    return next(p.commander for p in db.get_storage().players(app.state.event_id)
                if p.name == name)


# --- rendering --------------------------------------------------------------

def test_index_lists_the_seeded_roster(client):
    r = client.get("/admin")
    assert r.status_code == 200
    for name in SEEDED:
        assert name in r.text
    assert "Add a player" in r.text
    # Every mutation swaps the one #roster region — the rows carry the controls
    # because a <form> cannot live inside a <tr>.
    assert 'id="roster"' in r.text
    assert f'/admin/players/{_player_id(client, "Alice")}/delete' in r.text
    assert 'hx-include="closest tr"' in r.text


# --- add --------------------------------------------------------------------

def test_add_player_appends_without_reordering(client):
    ids_before = {n: _player_id(client, n) for n in SEEDED}

    r = client.post("/admin/players", data={"name": "Erin", "commander": "Atraxa"})
    assert r.status_code == 200
    assert "Erin" in r.text

    # Order is the scoring tiebreaker — a new player goes last and the existing
    # players keep both their order and their ids.
    assert _names(client) == [*SEEDED, "Erin"]
    assert {n: _player_id(client, n) for n in SEEDED} == ids_before
    assert _commander(client, "Erin") == "Atraxa"


def test_add_player_strips_whitespace(client):
    client.post("/admin/players", data={"name": "  Erin  ", "commander": "  Atraxa  "})
    assert "Erin" in _names(client)
    assert _commander(client, "Erin") == "Atraxa"


def test_add_player_rejects_a_blank_name(client):
    r = client.post("/admin/players", data={"name": "   ", "commander": ""})
    assert r.status_code == 422
    assert "Name is required" in r.text
    assert _names(client) == SEEDED


def test_add_player_rejects_a_duplicate_name(client):
    r = client.post("/admin/players", data={"name": "Alice", "commander": ""})
    assert r.status_code == 422
    assert "already on the roster" in r.text
    # The driver's error must never reach the operator.
    assert "IntegrityError" not in r.text
    assert _names(client) == SEEDED


def test_add_player_keeps_what_was_typed_after_a_rejection(client):
    r = client.post("/admin/players", data={"name": "Alice", "commander": "Krenko"})
    assert r.status_code == 422
    assert "Krenko" in r.text


def test_add_player_leaves_a_blank_commander_unset(client):
    client.post("/admin/players", data={"name": "Erin", "commander": "  "})
    assert _commander(client, "Erin") is None


# --- rename / commander -----------------------------------------------------

def test_rename_player_keeps_their_recorded_stats(client):
    record_stat(client, "Alice", 1, combat_dmg_dealt=40, final_life=5)
    alice = _player_id(client, "Alice")

    r = client.post(f"/admin/players/{alice}", data={"name": "Alicia", "commander": ""})
    assert r.status_code == 200

    # Stats key on player_id, so the row follows the rename rather than orphaning.
    assert _names(client) == ["Alicia", "Bob", "Carol", "Dave"]
    stats = db.get_storage().all_stats(app.state.event_id)
    # Only the player who actually finished a game: all_stats() returns a row
    # per seated player now, and the other three seats are still empty.
    assert [s.player for s in stats if s.placement is not None] == ["Alicia"]
    assert stats[0].combat_dmg_dealt == 40


def test_rename_strips_whitespace(client):
    alice = _player_id(client, "Alice")
    client.post(f"/admin/players/{alice}", data={"name": "  Alicia  ", "commander": ""})
    assert "Alicia" in _names(client)


def test_rename_rejects_a_blank_name(client):
    alice = _player_id(client, "Alice")
    r = client.post(f"/admin/players/{alice}", data={"name": "  ", "commander": ""})
    assert r.status_code == 422
    assert "Name is required" in r.text
    assert _names(client) == SEEDED


def test_rename_rejects_a_duplicate_name(client):
    alice = _player_id(client, "Alice")
    r = client.post(f"/admin/players/{alice}", data={"name": "Bob", "commander": ""})
    assert r.status_code == 422
    assert "already on the roster" in r.text
    assert "IntegrityError" not in r.text
    assert _names(client) == SEEDED


def test_commander_can_be_set_and_cleared(client):
    alice = _player_id(client, "Alice")

    client.post(f"/admin/players/{alice}", data={"name": "Alice", "commander": "Krenko"})
    assert _commander(client, "Alice") == "Krenko"

    r = client.post(f"/admin/players/{alice}", data={"name": "Alice", "commander": ""})
    assert _commander(client, "Alice") is None
    # A cleared commander must not render as the string "None".
    assert "None" not in r.text


def test_updating_an_unknown_player_is_a_clean_message(client):
    r = client.post("/admin/players/9999", data={"name": "Ghost", "commander": ""})
    assert r.status_code == 422
    assert "no longer on the roster" in r.text
    assert _names(client) == SEEDED


# --- delete -----------------------------------------------------------------

def test_delete_player_without_stats(client):
    dave = _player_id(client, "Dave")
    r = client.post(f"/admin/players/{dave}/delete")
    assert r.status_code == 200
    assert _names(client) == ["Alice", "Bob", "Carol"]


def test_delete_player_with_stats_is_refused(client):
    record_stat(client, "Alice", 1, combat_dmg_dealt=40, final_life=5)
    alice = _player_id(client, "Alice")

    r = client.post(f"/admin/players/{alice}/delete")
    assert r.status_code == 422
    assert "cannot be deleted" in r.text
    assert _names(client) == SEEDED
    # The cascade must not have fired.
    finished = [s for s in db.get_storage().all_stats(app.state.event_id)
                if s.placement is not None]
    assert len(finished) == 1


def test_deleting_an_unknown_player_is_a_clean_message(client):
    r = client.post("/admin/players/9999/delete")
    assert r.status_code == 422
    assert "no longer on the roster" in r.text


def test_delete_player_is_refused_in_the_storage_layer(client):
    """The guard has to be the database's, not the route's. A route-only check
    is a TOCTOU: a stat saved between the check and the delete would be
    cascaded away."""
    record_stat(client, "Alice", 1, combat_dmg_dealt=40, final_life=5)
    alice = _player_id(client, "Alice")
    storage = db.get_storage()

    # Called directly, with no route-level pre-check in front of it.
    assert storage.delete_player(app.state.event_id, alice) is False
    assert "Alice" in _names(client)
    finished = [s for s in storage.all_stats(app.state.event_id)
                if s.placement is not None]
    assert len(finished) == 1


@pytest.mark.parametrize("who", ["Carol", "Bob", "Dave"])
def test_storage_refuses_anyone_a_delete_would_take_a_game_from(client, who):
    """Every way a player can be part of a game, not only the death/win row.

    Carol has a turn, Bob was hit by it, Dave is only seated. None has finished,
    so none has a game_player_stats row, which is all the guard used to check.
    Deleting Bob cascaded away the 9 damage Carol dealt him; deleting Dave left
    a three-player table.
    """
    seat_table(client, names=["Carol", "Alice", "Dave", "Bob"])
    # Carol's opponents in seat order are Alice, Dave, Bob, so Bob is cell 3.
    assert record_turn(client, "Carol", damage={3: 9}).status_code == 200
    storage = db.get_storage()

    assert storage.delete_player(app.state.event_id, _player_id(client, who)) is False
    assert who in _names(client)
    game_id = storage.find_game(app.state.event_id, "A", 1)
    assert storage.seating(game_id) == ["Carol", "Alice", "Dave", "Bob"]
    assert storage.stat_for(game_id, "Carol").combat_dmg_dealt == 9


@pytest.mark.parametrize("who", ["Carol", "Bob", "Dave"])
def test_a_reseat_does_not_open_the_guard(client, who):
    """Reseating a table leaves what was recorded attached to the players it
    was recorded for, so once the table is reseated around them each of these
    is held by exactly one clause of the guard: Carol by a turn that hit
    nobody, Bob by a hit he took, Dave by a death/win row."""
    storage = db.get_storage()
    seat_table(client, names=["Carol", "Alice", "Dave", "Bob"])
    assert record_turn(client, "Carol").status_code == 200
    # Alice's opponents in seat order are Carol, Dave, Bob, so Bob is cell 3.
    assert record_turn(client, "Alice", damage={3: 9}).status_code == 200
    assert record_final(client, "Dave", 4).status_code == 200
    for name in ("Eve", "Frank", "Gina", "Hank"):
        storage.add_player(app.state.event_id, name, None)
    seat_table(client, names=["Eve", "Frank", "Gina", "Hank"])

    assert storage.delete_player(app.state.event_id, _player_id(client, who)) is False
    assert who in _names(client)
    game_id = storage.find_game(app.state.event_id, "A", 1)
    assert storage.turn_for(game_id, "Alice", 1).damage == {"Bob": 9}


def test_a_seated_player_is_refused_with_a_way_out(client):
    """Seated but not yet played is the case an operator will actually hit: a
    typo'd name dealt into a table. The fix is to reseat, so say so."""
    seat_table(client, names=["Carol", "Alice", "Dave", "Bob"])

    r = client.post(f"/admin/players/{_player_id(client, 'Dave')}/delete")
    assert r.status_code == 422
    assert "cannot be deleted" in r.text
    assert "reseat" in r.text
    assert "Dave" in _names(client)


def test_storage_refusal_does_not_claim_a_cause_it_did_not_establish(client, monkeypatch):
    """delete_player() returns False for any non-deletion, not just "has stats"
    — another admin deleting the player first lands here too. Blinding the
    pre-check reaches that branch; the message must stay generic."""
    record_stat(client, "Alice", 1, combat_dmg_dealt=40, final_life=5)
    alice = _player_id(client, "Alice")
    monkeypatch.setattr(SQLiteStorage, "player_has_stats", lambda self, player_id: False)

    r = client.post(f"/admin/players/{alice}/delete")
    assert r.status_code == 422
    assert "could not be deleted" in r.text
    assert "part of a game" not in r.text
    # The refusal is still real: the row and its stats survive.
    assert "Alice" in _names(client)
    finished = [s for s in db.get_storage().all_stats(app.state.event_id)
                if s.placement is not None]
    assert len(finished) == 1


def test_delete_player_is_scoped_to_the_event(client):
    storage = db.get_storage()
    dave = _player_id(client, "Dave")
    other_event, _ = storage.ensure_event("Some Other Event", 3)

    assert storage.delete_player(other_event, dave) is False
    assert "Dave" in _names(client)


def test_update_player_is_scoped_to_the_event(client):
    storage = db.get_storage()
    dave = _player_id(client, "Dave")
    other_event, _ = storage.ensure_event("Some Other Event", 3)

    storage.update_player(other_event, dave, "Hijacked", None)
    assert _names(client) == SEEDED


# --- length limits ----------------------------------------------------------

def test_add_player_rejects_an_overlong_name(client):
    r = client.post("/admin/players", data={"name": "x" * 61, "commander": ""})
    assert r.status_code == 422
    assert "60 characters or fewer" in r.text
    assert _names(client) == SEEDED


def test_add_player_rejects_an_overlong_commander(client):
    r = client.post("/admin/players", data={"name": "Erin", "commander": "y" * 81})
    assert r.status_code == 422
    assert "80 characters or fewer" in r.text
    assert _names(client) == SEEDED


def test_rename_rejects_an_overlong_name(client):
    alice = _player_id(client, "Alice")
    r = client.post(f"/admin/players/{alice}", data={"name": "x" * 61, "commander": ""})
    assert r.status_code == 422
    assert "60 characters or fewer" in r.text
    assert _names(client) == SEEDED


def test_maximum_length_name_is_accepted(client):
    r = client.post("/admin/players", data={"name": "x" * 60, "commander": "y" * 80})
    assert r.status_code == 200
    assert "x" * 60 in _names(client)


# --- malformed player ids ---------------------------------------------------

_BAD_IDS = [
    "abc",                    # not a number at all
    "99999999999999999999",   # int() succeeds; too wide for SQLite's signed 64-bit
    str(2**63),               # one past the maximum
    "-1",                     # int() succeeds; no player id is negative
    " 12 ",                   # int() strips whitespace; a path segment should not
    "1_2",                    # int() honours PEP 515 underscores
    "١٢",                     # non-ASCII digits — isdecimal() alone accepts these
    # The one above cannot actually detect a missing isascii(): int("١٢") is 12,
    # no seeded player has id 12, so it lands on the same _GONE 422 either way.
    # These two map onto SEEDED ids, so the roster assertion below fails if the
    # guard is ever removed as "redundant" — which is exactly how it would go.
    "١",                      # U+0661 -> 1 -> Alice
    "+1",                     # int() accepts a leading plus -> 1 -> Alice
    "9" * 4301,               # CPython refuses to int() a decimal string over
                              # 4300 digits; isascii()/isdecimal() both pass
]


@pytest.mark.parametrize("bad", _BAD_IDS)
@pytest.mark.parametrize("suffix", ["", "/delete"])
def test_a_malformed_player_id_re_renders_the_roster(client, bad, suffix):
    """Every malformed segment must land on the same polite 422 as 'abc'.

    base.html tells htmx to swap 422 bodies, so a raw validation payload would
    replace the roster region with JSON and cost the operator their page — and a
    500 (which an oversized id raised, via OverflowError inside get_player)
    leaves them with no feedback at all.
    """
    r = client.post(f"/admin/players/{bad}{suffix}", data={"name": "Ghost", "commander": ""})
    assert r.status_code == 422
    assert "no longer on the roster" in r.text
    assert 'id="roster"' in r.text
    assert "int_parsing" not in r.text
    assert _names(client) == SEEDED


def test_the_largest_valid_player_id_is_still_a_clean_422(client):
    """The bound rejects what SQLite cannot store, not what it can — the maximum
    is queried normally and simply finds no such player."""
    r = client.post(f"/admin/players/{2**63 - 1}/delete")
    assert r.status_code == 422
    assert "no longer on the roster" in r.text


def test_the_longest_convertible_player_id_is_still_a_clean_422(client):
    """4300 digits is the most int() will convert; one more raises ValueError.
    Both sides of that cliff must land on the same 422, so pin the last value
    that reaches the range check as well as the first that does not."""
    r = client.post(f"/admin/players/{'9' * 4300}/delete")
    assert r.status_code == 422
    assert "no longer on the roster" in r.text


def test_a_zero_padded_real_player_id_still_resolves(client):
    """A length cap on the segment would be cheaper than catching ValueError,
    but it would reject this, which resolves correctly today."""
    alice = _player_id(client, "Alice")
    r = client.post(f"/admin/players/{alice:020d}", data={"name": "Alicia", "commander": ""})
    assert r.status_code == 200
    assert "Alicia" in _names(client)


# --- the event bus ----------------------------------------------------------

def test_successful_mutations_publish_roster_changed(client, published):
    client.post("/admin/players", data={"name": "Erin", "commander": ""})
    assert published == ["roster-changed"]

    erin = _player_id(client, "Erin")
    client.post(f"/admin/players/{erin}", data={"name": "Erin B", "commander": ""})
    assert published == ["roster-changed"] * 2

    client.post(f"/admin/players/{erin}/delete")
    assert published == ["roster-changed"] * 3


def test_rejected_mutations_do_not_publish(client, published):
    alice = _player_id(client, "Alice")

    client.post("/admin/players", data={"name": "Alice", "commander": ""})   # duplicate
    client.post("/admin/players", data={"name": "  ", "commander": ""})      # blank
    client.post(f"/admin/players/{alice}", data={"name": "Bob", "commander": ""})
    client.post("/admin/players/9999/delete")
    assert published == []

    # ...including the refused delete, which is the one that matters.
    record_stat(client, "Alice", 1, combat_dmg_dealt=40, final_life=5)
    published.clear()
    assert client.post(f"/admin/players/{alice}/delete").status_code == 422
    assert published == []


# --- config seeds once ------------------------------------------------------

def test_config_does_not_resurrect_a_deleted_player_on_restart(env):
    with _session() as c:
        event_id = app.state.event_id
        dave = _player_id(c, "Dave")
        assert c.post(f"/admin/players/{dave}/delete").status_code == 200
        assert _names(c) == ["Alice", "Bob", "Carol"]

    # Same config, same database, second startup. Config seeds only an empty
    # event, so the deletion sticks.
    with _session() as c:
        assert app.state.event_id == event_id
        assert _names(c) == ["Alice", "Bob", "Carol"]


def test_config_does_not_reseed_a_roster_emptied_to_zero(env):
    """An empty roster is not a brand-new event. Seeding keys on whether
    ensure_event created the row, so deleting everyone and restarting leaves the
    roster empty rather than restoring the config list."""
    with _session() as c:
        for name in SEEDED:
            assert c.post(f"/admin/players/{_player_id(c, name)}/delete").status_code == 200
        assert _names(c) == []

    with _session() as c:
        assert _names(c) == []


def test_config_still_seeds_a_brand_new_event(client):
    assert _names(client) == SEEDED


# --- the guard --------------------------------------------------------------

def test_anonymous_mutations_are_redirected_to_login(env):
    db.close_connections()
    with TestClient(app) as anon:
        r = anon.post(
            "/admin/players", data={"name": "Mallory"}, follow_redirects=False
        )
        assert r.status_code == 303
        assert r.headers["location"].startswith("/login?next=")
        assert "Mallory" not in db.get_storage().roster(app.state.event_id)
    db.close_connections()


# --- players excluded from prizes -------------------------------------------

def _exclude(env, name):
    text = env.read_text()
    assert text.count("prize_ineligible: []") == 1
    env.write_text(text.replace("prize_ineligible: []", f"prize_ineligible: [{name}]"))


def test_renaming_a_player_excluded_from_prizes_is_refused(env, client):
    """The exclusion is by name in event.yaml, so a rename would quietly make
    the organiser eligible again."""
    _exclude(env, "Alice")
    alice = _player_id(client, "Alice")
    r = client.post(f"/admin/players/{alice}", data={"name": "Alicia", "commander": ""})
    assert r.status_code == 422
    assert "excluded from prizes" in r.text
    assert "Alice" in _names(client)


def test_the_rename_goes_through_once_the_new_name_is_excluded_too(env, client):
    env.write_text(env.read_text().replace(
        "prize_ineligible: []", "prize_ineligible: [Alice, Alicia]"))
    alice = _player_id(client, "Alice")
    r = client.post(f"/admin/players/{alice}", data={"name": "Alicia", "commander": ""})
    assert r.status_code == 200
    assert "Alicia" in _names(client)


def test_an_excluded_player_can_still_have_their_commander_set(env, client):
    _exclude(env, "Alice")
    alice = _player_id(client, "Alice")
    r = client.post(f"/admin/players/{alice}", data={"name": "Alice", "commander": "Atraxa"})
    assert r.status_code == 200
    assert _commander(client, "Alice") == "Atraxa"
