"""The turn form keeping each box as it is left.

A tracker four boxes into Alice's turn who has to jump to Bob -- to record the
death Alice's attack just caused -- used to come back to an empty form: the
player select re-GETs the panel from storage, and everything unsaved went with
it. Every numeric box now posts itself to /entry/turn/draft as it is left.

What these tests pin down is the difference between the autosave and the Save
button, because the two write the same row:

  the autosave   keeps the numbers, moves nothing, says what it kept
  Save           still advances to the next seat and marks the round entered

and the one place they disagree about what is acceptable: a turn halfway
through being typed breaks the rules that read one box against another, and
refusing to keep it is the thing the autosave exists to prevent.
"""
import pathlib
import shutil
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import db  # noqa: E402
from app.main import app  # noqa: E402
from tests.helpers import record_turn, seat_table  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
ROSTER = ["Alice", "Bob", "Carol", "Dave"]
PASSCODE = "test-passcode"


@pytest.fixture
def client(tmp_path, monkeypatch):
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


def _game_id(pod="A", match=1):
    return db.get_storage().find_game(app.state.event_id, pod, match)


def _turn(player="Alice", round_no=1):
    return db.get_storage().turn_for(_game_id(), player, round_no)


def autosave(client, player="Alice", *, pod="A", match=1, round_no=1,
             damage=None, table=None, **fields):
    """What a box fires when it is left: the whole form, posted to the draft
    endpoint, because hx-include sends the form and not just the one box."""
    payload = {
        "pod": pod,
        "match_no": str(match),
        "player": player,
        "round_no": str(round_no),
        "attacking_creatures": str(fields.get("attacking_creatures", "")),
        "cmdr_dmg_dealt": str(fields.get("cmdr_dmg_dealt", "")),
        "noncombat_dmg_dealt": str(fields.get("noncombat_dmg_dealt", "")),
        "opps_eliminated": str(fields.get("opps_eliminated", "")),
    }
    for seat, value in (damage or {}).items():
        payload[f"dmg_{seat}"] = str(value)
    if table is not None:
        payload["table"] = table
    return client.post("/entry/turn/draft", data=payload)


# --- what it keeps ----------------------------------------------------------

def test_a_number_is_kept_without_pressing_save(client):
    r = autosave(client, damage={1: 7})
    assert r.status_code == 200, r.text[:400]
    assert _turn().damage == {"Bob": 7}


def test_switching_player_does_not_lose_what_was_typed(client):
    """The whole point. Four boxes in, jump to Bob, come back."""
    autosave(client, damage={1: 7}, attacking_creatures=3)
    client.get("/entry", params={"pod": "A", "match_no": 1, "player": "Bob",
                                 "round_no": 1})
    body = client.get("/entry", params={"pod": "A", "match_no": 1,
                                        "player": "Alice", "round_no": 1}).text
    assert 'value="7"' in body
    assert 'value="3"' in body


def test_it_says_what_it_kept(client):
    """Named, not just "saved": the line is swapped in out of band, so it can
    land on a panel the tracker has already moved on from."""
    body = autosave(client, damage={1: 7}, round_no=2).text
    assert "Kept Alice round 2" in body
    assert 'hx-swap-oob="true"' in body


def test_it_moves_nothing(client):
    """No panel, no banner, no advance: a redraw mid-entry moves the box being
    typed in, which is its own way of losing what is in it."""
    body = autosave(client, damage={1: 7}).text
    assert 'id="entry-panel"' not in body
    assert 'id="turn-form"' not in body
    assert 'class="saved"' not in body


def test_a_half_typed_turn_is_kept_although_save_would_refuse_it(client):
    """Commander damage typed before the grid it belongs in. Save enforces that
    rule -- it is what keeps combat damage and every prize built on it whole --
    but the autosave is there to hold the numbers, not to grade them."""
    assert autosave(client, cmdr_dmg_dealt=10).status_code == 200
    assert _turn().cmdr_dmg_dealt == 10

    same_turn = record_turn(client, "Alice", cmdr_dmg_dealt=10)
    assert same_turn.status_code == 422
    assert "add it to the grid too" in same_turn.text


def test_the_save_button_still_advances_and_marks_the_round(client):
    autosave(client, damage={1: 7})
    body = record_turn(client, "Alice", damage={1: 7}).text
    assert "Round 1 saved for Alice" in body
    # Landed on the next seat, as it always did.
    assert 'data-player="Bob"' in body


def test_the_real_save_rewrites_the_draft_rather_than_adding_to_it(client):
    autosave(client, damage={1: 7})
    record_turn(client, "Alice", damage={1: 9})
    assert _turn().damage == {"Bob": 9}
    assert db.get_storage().rounds_played(_game_id()) == 1


def test_it_does_not_push_half_typed_numbers_to_the_display(client, monkeypatch):
    """The projector would otherwise update a box at a time, with numbers
    mid-typing. The Save button that finishes the turn is a second away."""
    from app.events import broadcaster

    published = []

    async def fake_publish(event):
        published.append(event)

    monkeypatch.setattr(broadcaster, "publish", fake_publish)

    autosave(client, damage={1: 7})
    assert published == []
    record_turn(client, "Alice", damage={1: 7})
    assert published == ["stats-updated"]


# --- when it cannot ---------------------------------------------------------

def test_a_box_that_is_not_a_number_is_not_kept_and_says_so(client):
    """A silent failure would be worse than no autosave at all: the tracker
    would switch player believing the numbers were safe."""
    r = autosave(client, attacking_creatures="x")
    # 200, not 422: htmx only applies an out-of-band swap from a response it
    # would swap, and a 4xx here also trips the "Not saved" connection banner.
    assert r.status_code == 200
    assert "not kept" in r.text
    assert "draft-status bad" in r.text
    assert _turn() is None


def test_an_overlarge_number_is_not_kept(client):
    r = autosave(client, damage={1: 10**7})
    assert "not kept" in r.text
    assert _turn() is None


def test_a_stale_table_is_not_kept(client):
    """The damage boxes are numbered by seat, so a form drawn before a reseat
    means its numbers against whoever sits in those seats now."""
    r = autosave(client, damage={1: 7}, table="Nobody|Else|Here")
    assert "the table changed" in r.text
    assert _turn() is None


def test_somebody_not_at_the_table_is_not_kept(client):
    r = autosave(client, player="Nobody", damage={1: 7})
    assert "not kept" in r.text
    assert "not at this table" in r.text


# --- the wiring -------------------------------------------------------------

def test_every_numeric_box_in_the_turn_form_is_wired_up(client):
    """Attackers, three damage boxes, and the three in "rest of the turn".

    The count matters because the player select and the round box are in the
    same form and must NOT be wired: they re-GET the panel, and an autosave
    fired off the same change event would file the numbers in front of the
    tracker under the player they just switched to.
    """
    body = client.get("/entry", params={"pod": "A", "match_no": 1}).text
    assert body.count("/entry/turn/draft") == 7
    # The two that switch instead of saving still do.
    assert body.count("/entry/form") >= 2


def test_the_status_line_is_on_the_form_for_the_swap_to_land_in(client):
    body = client.get("/entry", params={"pod": "A", "match_no": 1}).text
    assert 'id="turn-draft-status"' in body
