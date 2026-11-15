"""Recording everybody a turn put out, in one form.

The turn form says how many opponents a player eliminated; each dead player's
own section says who they were and how they finished. Entering the second
through /entry/final meant leaving the turn, selecting each dead player and
finding the way back, mid-game, on a phone. These tests are about the form that
does it in one submit -- and mostly about the placements, which it derives from
the order of the rows rather than asking for.

The simultaneous case is the common one: one attack killing two players is not
an order of elimination at all, and the event owner's rule ranks those by life
at death, least negative higher.
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
from app.scoring import build_standings  # noqa: E402
from tests.helpers import record_final, record_turn, seat_table  # noqa: E402

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


def _game_id(pod="A", match=1):
    return db.get_storage().find_game(app.state.event_id, pod, match)


def _final(name, pod="A", match=1):
    return db.get_storage().final_for(_game_id(pod, match), name)


def _placement(name, **kw):
    final = _final(name, **kw)
    return None if final is None else final.placement


def _placements(**kw):
    """{player: placement} for everybody recorded out at the table."""
    return {
        n: _placement(n, **kw) for n in ROSTER if (_final(n, **kw) or None) is not None
        and _placement(n, **kw) is not None
    }


def kills(client, n, *, player="Alice", round_no=1, pod="A", match=1):
    """Credit `n` eliminations to a player's turn, which is what raises the
    prompt. The damage is there because commander damage is not involved and a
    kill with no damage at all would be an odd row to read back."""
    r = record_turn(client, player, pod=pod, match=match, round_no=round_no,
                    opps_eliminated=n, damage={1: 12})
    assert r.status_code == 200, r.text[:800]
    return r


def save_out(client, rows, *, pod="A", match=1, round_no=1, simultaneous=False,
             winner=None):
    """POST the form the way the browser sends it: one `player`, `final_life`
    and `total_graveyard` per row, in document order. `rows` is
    (player, life at death, graveyard), first out first."""
    data = {
        "pod": pod,
        "match_no": str(match),
        "round_no": str(round_no),
        "player": [r[0] for r in rows],
        "final_life": [str(r[1]) for r in rows],
        "total_graveyard": [str(r[2]) for r in rows],
    }
    if simultaneous:
        data["simultaneous"] = "1"
    if winner is not None:
        data |= {"winner": winner[0], "winner_life": str(winner[1]),
                 "winner_graveyard": str(winner[2])}
    return client.post("/entry/eliminations", data=data)


# --- the prompt -------------------------------------------------------------

def test_a_turn_that_eliminated_somebody_asks_who_went_out(client):
    body = kills(client, 1).text
    assert "Who went out?" in body
    assert "1 to record" in body


def test_two_eliminations_ask_for_two_rows_in_order(client):
    body = kills(client, 2).text
    assert "2 to record" in body
    assert "1st out" in body
    assert "2nd out" in body


def test_a_turn_that_eliminated_nobody_asks_nothing(client):
    body = record_turn(client, "Alice", damage={1: 12}).text
    assert "went out" not in body


def test_the_prompt_survives_a_reload(client):
    """Derived from the turns, not flagged on the save that triggered it: a
    tracker whose phone sleeps mid-game comes back to the same question."""
    kills(client, 1)
    body = client.get("/entry", params={"pod": "A", "match_no": 1}).text
    assert "Who went out?" in body


def test_recording_the_death_takes_the_prompt_away(client):
    kills(client, 1)
    body = save_out(client, [("Bob", -3, 14)]).text
    assert "to record" not in body


def test_a_death_nobody_was_credited_for_raises_no_prompt(client):
    """A concede or a deck-out. Nothing credited it, so there is nothing
    outstanding, and the player's own form is where it goes."""
    body = record_final(client, "Bob", 4, final_life=0, total_graveyard=9).text
    assert "went out" not in body


# --- the placements ---------------------------------------------------------

def test_the_row_order_is_the_order_of_elimination(client):
    kills(client, 2)
    r = save_out(client, [("Bob", -1, 10), ("Carol", -9, 12)])
    assert r.status_code == 200, r.text[:800]
    # First out of four finishes 4th, even though Bob died on more life than
    # Carol: without the tick these are two separate deaths, in this order.
    assert _placement("Bob") == 4
    assert _placement("Carol") == 3


def test_a_simultaneous_pair_is_ranked_by_life_at_death(client):
    """One attack killing both. Least negative is the higher placement, which
    is the event owner's rule, so the row order cannot decide it."""
    kills(client, 2)
    save_out(client, [("Bob", -10, 10), ("Carol", -2, 12)], simultaneous=True)
    assert _placement("Carol") == 3
    assert _placement("Bob") == 4


def test_a_simultaneous_pair_lands_the_same_way_round_whichever_order_it_is_typed(client):
    kills(client, 2)
    save_out(client, [("Carol", -2, 12), ("Bob", -10, 10)], simultaneous=True)
    assert _placement("Carol") == 3
    assert _placement("Bob") == 4


def test_equal_life_in_a_simultaneous_death_shares_the_better_placement(client):
    """A genuine tie takes the best placement of the block it occupies: tied
    over 3rd and 4th, both finish 3rd and nobody finishes 4th. Docking both of
    them a place for having died at the same moment is the other reading of
    "tied players each receive the full placement score", and not this one."""
    kills(client, 2)
    save_out(client, [("Bob", -5, 10), ("Carol", -5, 12)], simultaneous=True)
    assert _placement("Bob") == 3
    assert _placement("Carol") == 3


def test_three_tied_simultaneous_deaths_all_take_the_best_of_their_block(client):
    """One attack, three dead on the same life total, one survivor: the three
    occupy 4th, 3rd and 2nd, so all three finish 2nd."""
    kills(client, 3)
    save_out(client, [("Bob", -5, 10), ("Carol", -5, 11), ("Dave", -5, 12)],
             simultaneous=True)
    assert _placements() == {"Bob": 2, "Carol": 2, "Dave": 2}


def test_a_tie_inside_a_bigger_simultaneous_group_is_one_block(client):
    """Bob died on less life than the other two, so he went out first and
    finishes 4th. Carol and Dave tie over 3rd and 2nd, and both take 2nd."""
    kills(client, 3)
    save_out(client, [("Bob", -10, 10), ("Carol", -5, 11), ("Dave", -5, 12)],
             simultaneous=True)
    assert _placements() == {"Bob": 4, "Carol": 2, "Dave": 2}


def test_the_numbers_land_on_the_player_whose_row_they_were_in(client):
    kills(client, 2)
    save_out(client, [("Bob", -1, 10), ("Carol", -9, 22)])
    assert _final("Bob").final_life == -1
    assert _final("Bob").total_graveyard == 10
    assert _final("Carol").final_life == -9
    assert _final("Carol").total_graveyard == 22


def test_a_death_after_an_earlier_one_takes_the_next_placement_up(client):
    kills(client, 1, round_no=1)
    save_out(client, [("Bob", -2, 10)])
    kills(client, 1, round_no=2)
    save_out(client, [("Carol", -4, 11)], round_no=2)
    assert _placements() == {"Bob": 4, "Carol": 3}


def test_life_at_death_may_be_negative(client):
    kills(client, 1)
    assert save_out(client, [("Bob", -37, 10)]).status_code == 200
    assert _final("Bob").final_life == -37


def test_the_placements_feed_the_win_points(client):
    kills(client, 2)
    save_out(client, [("Bob", -1, 10), ("Carol", -9, 12)])
    storage = db.get_storage()
    standings = {
        s.player: s
        for s in build_standings(storage.all_stats(app.state.event_id), load_scoring(),
                                 storage.roster(app.state.event_id))
    }
    # placement_points in the example config: 4th is 1 point, 3rd is 2.
    assert standings["Bob"].win_points == 1
    assert standings["Carol"].win_points == 2


# --- the winner -------------------------------------------------------------

def test_the_last_player_standing_is_asked_for_too(client):
    """The winner's own three numbers are the ones a tracker has to come back
    for after the table has broken up, so they are offered in the same form."""
    kills(client, 1, round_no=1)
    save_out(client, [("Bob", -2, 10)])
    body = kills(client, 2, round_no=2).text
    assert "and the winner" in body


def test_the_winner_row_records_first_place(client):
    kills(client, 1, round_no=1)
    save_out(client, [("Bob", -2, 10)])
    kills(client, 2, round_no=2)
    r = save_out(client, [("Carol", -5, 12), ("Dave", -8, 13)], round_no=2,
                 winner=("Alice", 22, 15))
    assert r.status_code == 200, r.text[:800]
    assert _placements() == {"Bob": 4, "Carol": 3, "Dave": 2, "Alice": 1}
    assert _final("Alice").final_life == 22
    assert _final("Alice").total_graveyard == 15


def test_the_winner_is_not_asked_for_while_the_game_is_still_on(client):
    """Two of four out leaves two playing, and neither of them has won."""
    body = kills(client, 1).text
    assert "and the winner" not in body


def test_the_banner_names_the_whole_finish_in_the_order_it_happened(client):
    kills(client, 1, round_no=1)
    save_out(client, [("Bob", -2, 10)])
    kills(client, 2, round_no=2)
    body = save_out(client, [("Carol", -5, 12), ("Dave", -8, 13)], round_no=2,
                    winner=("Alice", 22, 15)).text
    assert body.index("Dave finished 2nd") < body.index("Alice won")
    assert body.index("Carol finished 3rd") < body.index("Dave finished 2nd")


# --- what it refuses --------------------------------------------------------

def test_a_row_left_on_nobody_is_skipped(client):
    """Two kills credited, but the tracker only knows one of the deaths yet."""
    kills(client, 2)
    r = save_out(client, [("Bob", -1, 10), ("", "", "")])
    assert r.status_code == 200, r.text[:800]
    assert _placements() == {"Bob": 4}
    # Still one outstanding, so the form is still there.
    assert "1 to record" in r.text


def test_a_form_naming_nobody_does_not_claim_a_save(client):
    kills(client, 1)
    r = save_out(client, [("", "", "")])
    assert r.status_code == 200
    # The banner is the only proof a tracker gets, so it must not appear for a
    # save that did not happen. ("finished" alone would match the pod table's
    # "0 of 4 finished".)
    assert 'class="saved"' not in r.text
    assert _placements() == {}


def test_a_credited_kill_raises_the_rows_even_when_a_suicide_cancels_the_count(client):
    """Counts alone cannot tell a suicide from an uncredited kill, so a death
    with no credit can net out a kill that really is outstanding. The turn that
    credits the kill raises the rows itself for exactly this case."""
    # A suicide: recorded out, nobody credited with putting him out.
    record_final(client, "Dave", 4, final_life=0, total_graveyard=7)
    # Now a real kill. Credited 1, recorded 1 -- the difference is nothing,
    # and Bob's death is still unrecorded.
    assert "1 to record" in kills(client, 1).text


def test_the_suicide_masked_prompt_does_not_survive_a_reload(client):
    """The known edge of the fix above, written down rather than left to be
    discovered: once the save that credited the kill is off the screen, the
    derived count is back to nothing and the player's own form is the way in."""
    record_final(client, "Dave", 4, final_life=0, total_graveyard=7)
    kills(client, 1)
    body = client.get("/entry", params={"pod": "A", "match_no": 1}).text
    assert "to record" not in body


def test_listing_everybody_still_playing_is_refused(client):
    """The placements would run down to 1st and hand it to a dead player --
    the app inventing a winner for a game that had none."""
    kills(client, 3)
    r = save_out(client, [("Bob", -1, 10), ("Carol", -2, 11),
                          ("Dave", -3, 12), ("Alice", -4, 13)], simultaneous=True)
    assert r.status_code == 422
    assert "nobody standing" in r.text
    assert _placements() == {}


def test_listing_the_last_players_standing_is_refused(client):
    kills(client, 1, round_no=1)
    save_out(client, [("Bob", -1, 10)])
    kills(client, 2, round_no=2)
    r = save_out(client, [("Carol", -2, 11), ("Dave", -3, 12), ("Alice", -4, 13)],
                 round_no=2, simultaneous=True)
    assert r.status_code == 422
    assert "nobody standing" in r.text
    # The death already in is untouched.
    assert _placements() == {"Bob": 4}


def test_a_player_already_recorded_out_is_refused(client):
    """Rewriting a placement from here would renumber the finishing order
    around a death that is already inside it."""
    kills(client, 2)
    save_out(client, [("Bob", -1, 10)])
    r = save_out(client, [("Bob", -5, 11)])
    assert r.status_code == 422
    assert "already recorded out" in r.text
    assert _final("Bob").final_life == -1


def test_the_same_player_in_two_rows_is_refused(client):
    kills(client, 2)
    r = save_out(client, [("Bob", -1, 10), ("Bob", -2, 11)])
    assert r.status_code == 422
    assert "listed twice" in r.text
    assert _placements() == {}


def test_a_player_not_at_this_table_is_refused(client):
    kills(client, 1)
    r = save_out(client, [("Nobody", -1, 10)])
    assert r.status_code == 422
    assert "not at this table" in r.text


def test_a_winner_who_also_went_out_is_refused(client):
    kills(client, 2)
    r = save_out(client, [("Bob", -1, 10), ("Carol", -2, 11)],
                 winner=("Bob", 10, 12))
    assert r.status_code == 422
    assert "cannot both go out and win" in r.text
    assert _placements() == {}


def test_mismatched_lists_are_refused(client):
    """Only reachable by hand. Zipping short would file a death against
    somebody else's life total."""
    kills(client, 2)
    r = client.post("/entry/eliminations", data={
        "pod": "A", "match_no": "1", "round_no": "1",
        "player": ["Bob", "Carol"],
        "final_life": ["-1"],
        "total_graveyard": ["10", "12"],
    })
    assert r.status_code == 422
    assert _placements() == {}


def test_a_bad_number_is_refused_and_the_typing_comes_back(client):
    kills(client, 2)
    r = save_out(client, [("Bob", "x", 10), ("Carol", -9, 12)])
    assert r.status_code == 422
    assert "whole numbers only" in r.text
    assert _placements() == {}
    # Nine boxes is too many to retype over one bad digit, so the rest of the
    # tracker's numbers are still in the form that comes back.
    assert 'value="10"' in r.text
    assert 'value="-9"' in r.text


def test_an_overlarge_graveyard_is_refused(client):
    kills(client, 1)
    r = save_out(client, [("Bob", -1, 10**7)])
    assert r.status_code == 422
    assert _placements() == {}


def test_an_unknown_pod_is_refused(client):
    kills(client, 1)
    r = save_out(client, [("Bob", -1, 10)], pod="Z")
    assert r.status_code == 422
    assert _placements() == {}
