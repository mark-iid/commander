"""The night as it is actually run: eight players, two pods of four, three
matches, and the pods dealt again before every match.

Everything else in the suite seats one table of four. This plays the whole
format through the HTTP routes a tracker uses, so it is the test that says the
app can run the event: a player's stats follow them from table to table, and
nobody ends the night with a game too many or too few.
"""
import pathlib
import re
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import db  # noqa: E402
from app.config import load_scoring  # noqa: E402
from app.main import app  # noqa: E402
from app.scoring import leaderboard  # noqa: E402
from tests.helpers import record_final, record_turn, seat_table  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
ROSTER = ["Alice", "Bob", "Carol", "Dave", "Erin", "Frank", "Grace", "Heidi"]
PASSCODE = "test-passcode"

# Seat order is turn order, and in this night it is also finishing order: seat
# 1 comes first, seat 4 comes fourth. Every match deals the pods differently.
TABLES = {
    1: {"A": ["Alice", "Bob", "Carol", "Dave"], "B": ["Erin", "Frank", "Grace", "Heidi"]},
    2: {"A": ["Alice", "Bob", "Erin", "Frank"], "B": ["Carol", "Dave", "Grace", "Heidi"]},
    3: {"A": ["Alice", "Carol", "Erin", "Grace"], "B": ["Bob", "Dave", "Frank", "Heidi"]},
}

# 4/3/2/1 by seat, summed over the three tables above.
WIN_POINTS = {
    "Alice": 4 + 4 + 4, "Bob": 3 + 3 + 4, "Carol": 2 + 4 + 3, "Dave": 1 + 3 + 3,
    "Erin": 4 + 2 + 2, "Frank": 3 + 1 + 2, "Grace": 2 + 2 + 1, "Heidi": 1 + 1 + 1,
}


@pytest.fixture
def client(tmp_path, monkeypatch):
    cfg = tmp_path / "event.yaml"
    text = (ROOT / "config" / "event.example.yaml").read_text()
    seeded = text.replace(
        "roster:\n  - Alice\n  - Bob\n  - Carol\n  - Dave",
        "roster:\n" + "\n".join(f"  - {n}" for n in ROSTER),
    )
    assert seeded != text, "the example config's roster block moved"
    cfg.write_text(seeded)
    monkeypatch.setenv("EVENT_CONFIG", str(cfg))
    monkeypatch.setenv("DB_PATH", str(tmp_path / "night.db"))
    monkeypatch.setenv("TRACKER_PASSCODE", PASSCODE)
    monkeypatch.setenv("SESSION_SECRET", "0" * 64)
    db.close_connections()
    with TestClient(app) as c:
        assert c.post("/login", data={"passcode": PASSCODE},
                      follow_redirects=False).status_code == 303
        yield c
    db.close_connections()


def _play(client, match, pod, seating):
    """One table: everyone takes a turn, then they go out from seat 4 up.

    Erin hits harder than anyone and Carol is the commander deck, so the
    night-scope prizes can only come out right if their numbers follow them
    across tables.
    """
    seat_table(client, pod, match, seating)
    for name in seating:
        r = record_turn(
            client, name, pod=pod, match=match, round_no=1,
            damage={1: 7 if name == "Erin" else 5},
            cmdr_dmg_dealt=5 if name == "Carol" else 0,
        )
        assert r.status_code == 200, r.text[:800]
    for place, name in reversed(list(enumerate(seating, start=1))):
        r = record_final(client, name, place, pod=pod, match=match, final_life=-place)
        assert r.status_code == 200, r.text[:800]


def _play_night(client):
    for match, pods in TABLES.items():
        for pod, seating in pods.items():
            _play(client, match, pod, seating)


def _standings(client):
    from app.scoring import build_standings

    storage = db.get_storage()
    event_id = app.state.event_id
    return {
        s.player: s
        for s in build_standings(storage.all_stats(event_id), load_scoring(),
                                 storage.roster(event_id))
    }


def _prizes(client):
    storage = db.get_storage()
    event_id = app.state.event_id
    return {
        p.key: (p.winner, p.value)
        for p in leaderboard(storage.all_stats(event_id), load_scoring(),
                             storage.roster(event_id))
    }


def test_the_second_pod_is_offered_only_who_is_left(client):
    """Dealing pod A first leaves exactly four names for pod B's seats."""
    for match, pods in TABLES.items():
        seat_table(client, "A", match, pods["A"])
        page = client.get("/entry", params={"pod": "B", "match_no": match}).text
        first_seat = re.search(r'<select name="seat">(.*?)</select>', page, re.S).group(1)
        offered = re.findall(r'<option value="([^"]+)"', first_seat)
        assert offered == pods["B"], f"match {match}"


def test_every_player_plays_three_games(client):
    _play_night(client)
    assert {name: s.games_played for name, s in _standings(client).items()} == {
        name: 3 for name in ROSTER
    }


def test_win_points_add_up_across_different_tables(client):
    _play_night(client)
    assert {name: s.win_points for name, s in _standings(client).items()} == WIN_POINTS


def test_prizes_follow_a_player_from_table_to_table(client):
    _play_night(client)
    prizes = _prizes(client)
    assert prizes["technical_winner"] == ("Alice", 12)
    assert prizes["blame_it_on_shuffling"] == ("Heidi", 3)
    # Erin was in pod B, then A, then A: 7 a match only adds to 21 if her
    # damage is the player's and not the pod's.
    assert prizes["does_nobody_block"] == ("Erin", 21)
    assert prizes["twenty_one_less_than_forty"] == ("Carol", 15)


def test_the_results_sheet_calls_the_night_final(client):
    _play_night(client)
    page = client.get("/results").text
    assert "Final results · 8 players · 3 games each" in page
    assert "Provisional" not in page


def test_two_matches_in_the_night_is_still_provisional(client):
    for match in (1, 2):
        for pod, seating in TABLES[match].items():
            _play(client, match, pod, seating)
    page = client.get("/results").text
    assert "16 of 24 player-games" in page


def test_a_player_excluded_from_prizes_is_skipped_on_every_page(client, tmp_path):
    """Alice tops the night. Excluded, Technical Winner goes to Bob, the runner-up,
    on the projector and on the results sheet alike, since each page resolves
    the prizes for itself."""
    _play_night(client)
    cfg = tmp_path / "event.yaml"
    text = cfg.read_text()
    assert text.count("prize_ineligible: []") == 1
    cfg.write_text(text.replace("prize_ineligible: []", "prize_ineligible: [Alice]"))

    board = client.get("/display").text
    sheet = client.get("/results").text
    on_board = re.search(
        r'<span class="name">Technical Winner</span>\s*<span class="winner">([^<]*)</span>', board)
    on_sheet = re.search(r"<td>Technical Winner</td>\s*<td>([^<]*)</td>", sheet)
    assert on_board.group(1) == "Bob"
    assert on_sheet.group(1) == "Bob"
    # Still first in the standings: she played, and her points count.
    assert _standings(client)["Alice"].win_points == 12


# --- fixing the seating after play has started ------------------------------
# A tracker who seats Dave in pod A when he is really in pod B finds out a few
# turns in. Reseating deletes nothing, so every total has to count only the
# players at the table now, or the hits recorded against Dave stay on the board.

def _alice_hits_dave_and_dave_hits_back(client):
    seat_table(client, "A", 1, ["Alice", "Bob", "Carol", "Dave"])
    # Alice's opponents are Bob, Carol, Dave; Dave's are Alice, Bob, Carol.
    assert record_turn(client, "Alice", damage={3: 9}).status_code == 200
    assert record_turn(client, "Dave", damage={1: 6}).status_code == 200


def test_a_player_reseated_away_takes_no_damage_with_them_or_leaves_any(client):
    _alice_hits_dave_and_dave_hits_back(client)
    seat_table(client, "A", 1, ["Alice", "Bob", "Carol", "Erin"])

    alice = _standings(client)["Alice"]
    assert alice.totals["combat_dmg_dealt"] == 0
    assert alice.totals["combat_dmg_taken"] == 0
    assert alice.peaks["biggest_attack_dealt"] == 0
    assert _prizes(client)["no_apologies"] == (None, None)
    turns = client.get("/results/turns.csv").text
    assert not any(line.startswith("1,A,Dave,") for line in turns.splitlines())


def test_seating_the_right_player_back_restores_what_was_recorded(client):
    _alice_hits_dave_and_dave_hits_back(client)
    seat_table(client, "A", 1, ["Alice", "Bob", "Carol", "Erin"])
    # Fixing Alice's attackers re-saves her round one, where Erin now sits in
    # Dave's box. That must not delete the hit on Dave it cannot show.
    assert record_turn(client, "Alice", damage={}, attacking_creatures=2).status_code == 200
    seat_table(client, "A", 1, ["Alice", "Bob", "Carol", "Dave"])

    alice = _standings(client)["Alice"]
    assert alice.totals["combat_dmg_dealt"] == 9
    assert alice.totals["combat_dmg_taken"] == 6


def test_two_players_can_swap_pods_once_everyone_is_dealt(client):
    seat_table(client, "A", 1, TABLES[1]["A"])
    seat_table(client, "B", 1, TABLES[1]["B"])
    # Dave and Erin are the wrong way round. Each table refuses the other's
    # player while they are seated, so one table is cleared first.
    stuck = client.post("/entry/seat", data={
        "pod": "B", "match_no": "1", "seat": ["Dave", "Frank", "Grace", "Heidi"]})
    assert stuck.status_code == 422

    page = client.get("/entry", params={"pod": "A", "match_no": 1}).text
    assert 'name="clear" value="1"' in page
    cleared = client.post("/entry/seat", data={"pod": "A", "match_no": "1", "clear": "1"})
    assert cleared.status_code == 200
    assert "Table cleared" in cleared.text
    seat_table(client, "B", 1, ["Dave", "Frank", "Grace", "Heidi"])
    seat_table(client, "A", 1, ["Alice", "Bob", "Carol", "Erin"])

    storage = db.get_storage()
    event_id = app.state.event_id
    seated = {storage.find_game(event_id, pod, 1): pod for pod in ("A", "B")}
    assert {pod: storage.seating(gid) for gid, pod in seated.items()} == {
        "A": ["Alice", "Bob", "Carol", "Erin"], "B": ["Dave", "Frank", "Grace", "Heidi"]}


def test_a_form_drawn_before_a_reseat_is_not_saved_against_the_new_seats(client):
    seat_table(client, "A", 1, ["Alice", "Bob", "Carol", "Dave"])
    page = client.get("/entry", params={"pod": "A", "match_no": 1, "player": "Alice"}).text
    drawn_for = re.search(r'name="table" value="([^"]*)"', page).group(1)
    assert drawn_for == "Bob|Carol|Dave"

    # Another phone reseats the table: seat 1 of Alice's boxes is Dave now.
    seat_table(client, "A", 1, ["Alice", "Dave", "Carol", "Bob"])
    stale = client.post("/entry/turn", data={
        "pod": "A", "match_no": "1", "player": "Alice", "round_no": "1",
        "table": drawn_for, "dmg_1": "8"})
    assert stale.status_code == 422
    assert "the table changed" in stale.text
    assert _standings(client)["Alice"].games_played == 0
