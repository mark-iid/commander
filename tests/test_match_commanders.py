"""A different deck for each match.

Players may bring a different commander to every match of the night, so the deck
is recorded per (player, match) rather than once on the roster. The tests that
matter here are the ones about what does NOT disturb it: the pods and the seats
are dealt again before every match, and neither a reseat nor a swap between
tables may move a deck onto the wrong person or lose it.

Nothing here touches scoring, and that is deliberate — commander damage travels
with the person, not with the deck they brought (event owner's call, 2026-11-14).
test_swapping_decks_does_not_split_a_player_s_commander_damage is that decision
written down as an assertion.
"""
import pathlib
import shutil
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import db  # noqa: E402
from app.config import load_scoring  # noqa: E402
from app.main import app  # noqa: E402
from app.models import COMMANDER_MAX  # noqa: E402
from app.scoring import build_standings  # noqa: E402
from tests.helpers import record_stat, seat_table  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
ROSTER = ["Alice", "Bob", "Carol", "Dave"]
PASSCODE = "test-passcode"


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A signed-in tracker with pod A of match 1 already seated."""
    cfg = tmp_path / "event.yaml"
    shutil.copy(ROOT / "config" / "event.example.yaml", cfg)
    monkeypatch.setenv("EVENT_CONFIG", str(cfg))
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("TRACKER_PASSCODE", PASSCODE)
    monkeypatch.setenv("SESSION_SECRET", "0" * 64)
    db.close_connections()
    with TestClient(app) as c:
        assert c.post("/login", data={"passcode": PASSCODE},
                      follow_redirects=False).status_code == 303
        seat_table(c, "A", 1, ROSTER)
        yield c
    db.close_connections()


def _event_id():
    return app.state.event_id


def _decks(match=1):
    return db.get_storage().commanders_for_match(_event_id(), match)


def save_decks(client, by_player, *, pod="A", match=1):
    """POST the decks form the way the browser sends it: parallel lists, one
    `player` and one `commander` per box, in document order."""
    return client.post("/entry/commanders", data={
        "pod": pod,
        "match_no": str(match),
        "player": list(by_player),
        "commander": [by_player[n] for n in by_player],
    })


# --- recording --------------------------------------------------------------

def test_a_deck_is_recorded_against_the_player_and_the_match(client):
    r = save_decks(client, {"Alice": "Atraxa", "Bob": "Krenko"})
    assert r.status_code == 200, r.text[:800]
    assert _decks(1) == {"Alice": "Atraxa", "Bob": "Krenko"}


def test_each_match_takes_its_own_deck(client):
    save_decks(client, {"Alice": "Atraxa"}, match=1)
    seat_table(client, "A", 2, ROSTER)
    save_decks(client, {"Alice": "Krenko"}, match=2)

    assert _decks(1) == {"Alice": "Atraxa"}
    assert _decks(2) == {"Alice": "Krenko"}


def test_a_deck_is_stored_without_its_surrounding_whitespace(client):
    save_decks(client, {"Alice": "  Atraxa  "})
    assert _decks(1) == {"Alice": "Atraxa"}


def test_emptying_a_box_records_no_deck_at_all(client):
    save_decks(client, {"Alice": "Atraxa", "Bob": "Krenko"})
    save_decks(client, {"Alice": "", "Bob": "Krenko"})
    # Absent, not stored as "": "no deck recorded" is one state (schema.sql).
    assert _decks(1) == {"Bob": "Krenko"}


def test_saving_one_pod_leaves_the_other_pod_s_decks_alone(client):
    """The two tables of a match are entered by two different trackers."""
    save_decks(client, {"Alice": "Atraxa", "Bob": "Krenko"}, pod="A", match=1)
    seat_table(client, "A", 2, ["Carol", "Dave", "Alice", "Bob"])
    save_decks(client, {"Carol": "Edgar"}, pod="A", match=2)

    assert _decks(1) == {"Alice": "Atraxa", "Bob": "Krenko"}


def test_a_deck_is_not_recorded_for_somebody_not_at_the_table(client):
    """A stale tab naming a player who has since moved pods."""
    seat_table(client, "A", 1, ["Alice", "Bob", "Carol", "Dave"])
    r = save_decks(client, {"Alice": "Atraxa", "Nobody": "Ghost"})
    assert r.status_code == 200
    assert _decks(1) == {"Alice": "Atraxa"}


# --- what must not disturb a deck ------------------------------------------

def test_a_deck_survives_a_reseat_of_the_same_table(client):
    save_decks(client, {"Alice": "Atraxa"})
    seat_table(client, "A", 1, ["Dave", "Carol", "Bob", "Alice"])
    assert _decks(1) == {"Alice": "Atraxa"}


def test_a_deck_follows_a_player_to_the_other_pod(client):
    """The whole reason the deck is not a column on game_seats: a swap between
    pods deletes the seat row under one game_id and writes another."""
    save_decks(client, {"Alice": "Atraxa"}, pod="A", match=1)

    # Free the table, then deal the same four at pod B of the same match.
    client.post("/entry/seat", data={"pod": "A", "match_no": "1", "clear": "1"})
    seat_table(client, "B", 1, ROSTER)

    assert _decks(1) == {"Alice": "Atraxa"}


def test_seating_a_table_records_no_deck_of_its_own(client):
    """The seating form carries no commander boxes, so seating must neither
    write nor blank one. A pod dealt before anybody picks a deck is normal."""
    assert _decks(1) == {}


def test_a_results_reset_clears_the_decks(client):
    save_decks(client, {"Alice": "Atraxa"})
    db.get_storage().clear_results(_event_id())
    # A deck left pre-filled for a match with no results would silently
    # reappear on the entry screen, which is why seating goes too.
    assert _decks(1) == {}


# --- the form ---------------------------------------------------------------

def test_the_boxes_offer_the_roster_deck_until_the_match_has_one(client):
    alice = next(p for p in db.get_storage().players(_event_id()) if p.name == "Alice")
    client.post(f"/admin/players/{alice.player_id}",
                data={"name": "Alice", "commander": "Atraxa"})

    body = client.get("/entry", params={"pod": "A", "match_no": 1}).text
    assert 'value="Atraxa"' in body
    # A pre-filled box is a suggestion, not a record.
    assert _decks(1) == {}

    save_decks(client, {"Alice": "Krenko", "Bob": "", "Carol": "", "Dave": ""})
    body = client.get("/entry", params={"pod": "A", "match_no": 1}).text
    assert 'value="Krenko"' in body
    assert 'value="Atraxa"' not in body


def test_every_seated_player_gets_a_box(client):
    body = client.get("/entry", params={"pod": "A", "match_no": 1}).text
    for name in ROSTER:
        assert f'aria-label="Commander for {name}"' in body


def test_an_overlong_deck_is_refused_and_nothing_is_stored(client):
    r = save_decks(client, {"Alice": "x" * (COMMANDER_MAX + 1)})
    assert r.status_code == 422
    assert f"{COMMANDER_MAX} characters or fewer" in r.text
    assert _decks(1) == {}


def test_a_form_with_mismatched_lists_is_refused(client):
    """Only reachable by hand. Zipping short would drop the tail and still
    report success for decks it never saved."""
    r = client.post("/entry/commanders", data={
        "pod": "A", "match_no": "1",
        "player": ["Alice", "Bob"],
        "commander": ["Atraxa"],
    })
    assert r.status_code == 422
    assert _decks(1) == {}


def test_a_form_naming_nobody_at_the_table_does_not_claim_a_save(client):
    r = save_decks(client, {"Nobody": "Ghost"})
    assert r.status_code == 200
    assert "Commanders saved" not in r.text
    assert _decks(1) == {}


def test_an_unknown_pod_is_refused(client):
    r = save_decks(client, {"Alice": "Atraxa"}, pod="Z")
    assert r.status_code == 422
    assert _decks(1) == {}


# --- scoring is not involved -----------------------------------------------

def test_swapping_decks_does_not_split_a_player_s_commander_damage(client):
    """Commander damage travels with the person, not the deck.

    Alice brings a different commander to each of two matches and deals 10 then
    7 with them. Her night's cmdr_dmg_dealt is 17: the prizes that read it are
    scope: night and know nothing about decks.

    The combat figures match the commander ones because commander damage IS
    combat damage and the turn form refuses a box that exceeds its grid.
    """
    record_stat(client, "Alice", 1, pod="A", match=1,
                combat_dmg_dealt=10, cmdr_dmg_dealt=10)
    save_decks(client, {"Alice": "Atraxa"}, match=1)

    seat_table(client, "A", 2, ROSTER)
    record_stat(client, "Alice", 1, pod="A", match=2,
                combat_dmg_dealt=7, cmdr_dmg_dealt=7)
    save_decks(client, {"Alice": "Krenko"}, match=2)

    storage = db.get_storage()
    standings = {
        s.player: s
        for s in build_standings(storage.all_stats(_event_id()), load_scoring(),
                                 storage.roster(_event_id()))
    }
    assert standings["Alice"].totals["cmdr_dmg_dealt"] == 17


# --- the take-home record ---------------------------------------------------

def test_the_results_sheet_names_the_deck_for_each_match(client):
    record_stat(client, "Alice", 1, pod="A", match=1, combat_dmg_dealt=12)
    save_decks(client, {"Alice": "Atraxa"}, match=1)

    seat_table(client, "A", 2, ROSTER)
    record_stat(client, "Alice", 1, pod="A", match=2, combat_dmg_dealt=9)
    save_decks(client, {"Alice": "Krenko"}, match=2)

    body = client.get("/results").text
    assert "Atraxa" in body
    assert "Krenko" in body


def test_the_results_csv_carries_the_deck_on_the_per_game_row(client):
    record_stat(client, "Alice", 1, pod="A", match=1, combat_dmg_dealt=12)
    save_decks(client, {"Alice": "Atraxa"}, match=1)

    lines = client.get("/results.csv").text.splitlines()
    header = lines[0].split(",")
    assert header[:4] == ["match", "pod", "player", "commander"]

    alice = next(line.split(",") for line in lines[1:] if line.split(",")[2] == "Alice")
    assert alice[3] == "Atraxa"


def test_a_player_with_no_deck_recorded_leaves_the_csv_cell_empty(client):
    record_stat(client, "Alice", 1, pod="A", match=1, combat_dmg_dealt=12)

    lines = client.get("/results.csv").text.splitlines()
    alice = next(line.split(",") for line in lines[1:] if line.split(",")[2] == "Alice")
    assert alice[3] == ""
