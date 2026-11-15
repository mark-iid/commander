"""The results sheet and its CSV.

The sheet's one real obligation is not to overstate itself. A snapshot taken
after round one and the final standings render identically otherwise, and the
difference matters to whoever reads the PDF next week — so "Final results" must
appear only when every rostered player has every game recorded.

The CSV's obligation is to be a faithful record: every recorded row present,
every configured stat field as a column, and stable ordering so two exports of
the same data are byte-identical.
"""
from __future__ import annotations

import contextlib
import csv
import io
import pathlib
import re
import shutil
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import GAME_STAT_FIELDS  # noqa: E402
from tests.helpers import record_stat, record_turn, seat_table  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
PASSCODE = "test-passcode"
ROSTER = ["Alice", "Bob", "Carol", "Dave"]


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
def _session(sign_in: bool = True):
    db.close_connections()
    with TestClient(app) as c:
        if sign_in:
            assert c.post("/login", data={"passcode": PASSCODE},
                          follow_redirects=False).status_code == 303
        yield c
    db.close_connections()


@pytest.fixture
def client(tmp):
    with _session() as c:
        yield c


def _record(client, *, pod, round_, player, placement, **stats):
    """One player's whole game. `round_` is the match number -- what the tracking
    sheet calls "Match #", and what a round used to mean here."""
    return record_stat(client, player, placement, pod=pod, match=round_, **stats)


def _play_full_night(client):
    """Every rostered player, every round — a complete event."""
    for round_ in (1, 2, 3):
        for i, player in enumerate(ROSTER):
            _record(client, pod="A", round_=round_, player=player,
                    placement=i + 1, combat_dmg_dealt=10 * (i + 1))


# --- the page ---------------------------------------------------------------

def test_results_needs_the_passcode_even_when_the_board_is_public(tmp):
    """The board is open by default; the CSV is per-game rows for named people."""
    with _session(sign_in=False) as anon:
        assert anon.get("/display").status_code == 200
        assert anon.get("/results", follow_redirects=False).status_code == 303
        assert anon.get("/results.csv", follow_redirects=False).status_code == 303


def test_an_empty_event_still_renders(client):
    body = client.get("/results").text
    assert "No games recorded yet." in body
    assert "Final results" not in body


def test_a_partial_event_is_labelled_provisional(client):
    _record(client, pod="A", round_=1, player="Alice", placement=1, combat_dmg_dealt=40)
    body = client.get("/results").text
    assert "Provisional" in body
    assert "Final results" not in body


def test_a_complete_event_is_labelled_final(client):
    _play_full_night(client)
    body = client.get("/results").text
    assert "Final results" in body
    assert "Provisional" not in body


def test_one_missing_row_keeps_the_sheet_provisional(client):
    """The boundary that matters: 11 of 12 player-games is not a final result."""
    for round_ in (1, 2, 3):
        for i, player in enumerate(ROSTER):
            if round_ == 3 and player == "Dave":
                continue
            _record(client, pod="A", round_=round_, player=player, placement=i + 1)
    body = client.get("/results").text
    assert "Provisional" in body
    assert "Final results" not in body


def test_the_sheet_shows_standings_awards_and_each_game(client):
    _play_full_night(client)
    body = client.get("/results").text
    assert "Standings" in body and "Awards" in body
    for player in ROSTER:
        assert player in body
    for round_ in (1, 2, 3):
        assert f"Match {round_}" in body


def test_every_stat_field_has_a_short_heading():
    """The game-by-game table prints eleven columns across A4. A stat added
    without a short heading renders a blank column header, which looks like a
    rendering bug rather than a missing string."""
    missing = [f.name for f in GAME_STAT_FIELDS if not f.short.strip()]
    assert not missing, f"no short heading for {missing}"
    assert all(len(f.short) <= 10 for f in GAME_STAT_FIELDS)


def test_the_abbreviated_headings_are_explained_on_the_sheet(client):
    """Someone reading the PDF next week never saw the entry form."""
    _play_full_night(client)
    body = client.get("/results").text
    for f in GAME_STAT_FIELDS:
        assert f.short in body
        assert f.label in body, f"{f.short} is never expanded"


def test_the_sheet_links_the_csv(client):
    assert "/results.csv" in client.get("/results").text


# --- the csv ----------------------------------------------------------------

def _rows(client):
    response = client.get("/results.csv")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    return response, list(csv.reader(io.StringIO(response.text)))


def test_csv_downloads_with_a_named_file(client):
    _play_full_night(client)
    response, _ = _rows(client)
    disposition = response.headers["content-disposition"]
    assert disposition.startswith("attachment;")
    assert disposition.endswith('.csv"')


def test_csv_has_a_column_per_configured_stat(client):
    _, rows = _rows(client)
    header = rows[0]
    # `commander` sits with the player, not with the stats: it is the deck they
    # brought to THAT match, and may differ in the next one.
    assert header[:6] == [
        "match", "pod", "player", "commander", "placement", "final_life",
    ]
    assert header[6:] == [f.name for f in GAME_STAT_FIELDS]


def test_csv_carries_every_recorded_row(client):
    _play_full_night(client)
    _, rows = _rows(client)
    assert len(rows) == 1 + len(ROSTER) * 3


def test_csv_records_the_values_that_were_entered(client):
    _record(client, pod="A", round_=1, player="Alice", placement=1,
            final_life="17", combat_dmg_dealt=42)
    _, rows = _rows(client)
    row = dict(zip(rows[0], rows[1], strict=True))
    assert row["player"] == "Alice"
    assert row["match"] == "1"
    assert row["pod"] == "A"
    assert row["placement"] == "1"
    assert row["final_life"] == "17"
    assert row["combat_dmg_dealt"] == "42"


def test_csv_is_byte_stable_across_exports(client):
    """Two exports of unchanged data should diff clean, so a saved copy can be
    compared against a later one without noise."""
    _play_full_night(client)
    first = client.get("/results.csv").text
    second = client.get("/results.csv").text
    assert first == second


def test_csv_is_ordered_by_round_then_pod_then_placement(client):
    for round_ in (2, 1):
        for i, player in enumerate(reversed(ROSTER)):
            _record(client, pod="A", round_=round_, player=player, placement=4 - i)
    _, rows = _rows(client)
    # Read by name rather than by index: the columns moved along one when
    # `commander` was inserted, and this assertion silently passed on the
    # wrong field until it hit a blank one.
    header = rows[0]
    match_i, pod_i, place_i = (header.index(c) for c in ("match", "pod", "placement"))
    ordering = [(int(r[match_i]), r[pod_i], int(r[place_i])) for r in rows[1:]]
    assert ordering == sorted(ordering)


def test_an_empty_event_exports_a_header_only(client):
    _, rows = _rows(client)
    assert len(rows) == 1


# --- turn-level export and the damage matrix ---------------------------------
#
# The two views that only exist because combat damage is stored per opponent.
# Until they landed, the night's most detailed data was recorded and then never
# left the app: /results.csv aggregates it away.


def _skirmish(client):
    """One match where everybody swings at Alice, so the margins are checkable.

      Alice  -> Bob 6, Carol 3  (r1)  then Bob 14 (r2)   = 23 dealt
      Bob    -> Alice 11        (r1)                     = 11
      Carol  -> Alice 7, Dave 2 (r1)                     =  9
      Dave   -> Alice 9         (r2)                     =  9
                                                   total = 52
      Taken: Alice 27, Bob 20, Carol 3, Dave 2     total = 52
    """
    seat_table(client, "A", 1, ROSTER)
    record_turn(client, "Alice", round_no=1, damage={1: 6, 2: 3}, attacking_creatures=2)
    record_turn(client, "Bob", round_no=1, damage={1: 11})
    record_turn(client, "Carol", round_no=1, damage={1: 7, 3: 2})
    record_turn(client, "Alice", round_no=2, damage={1: 14}, attacking_creatures=5)
    record_turn(client, "Dave", round_no=2, damage={1: 9})


def _turn_rows(client):
    response = client.get("/results/turns.csv")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    return response, list(csv.reader(io.StringIO(response.text)))


def test_turns_csv_has_a_row_per_recorded_turn(client):
    _skirmish(client)
    _, rows = _turn_rows(client)
    assert len(rows) == 1 + 5


def test_turns_csv_has_a_damage_column_per_rostered_player(client):
    _skirmish(client)
    _, rows = _turn_rows(client)
    header = rows[0]
    for name in ROSTER:
        assert f"dmg_to_{name}" in header
    assert header[:4] == ["match", "pod", "player", "round"]


def test_turns_csv_attributes_damage_to_the_named_opponent(client):
    _skirmish(client)
    _, rows = _turn_rows(client)
    row = dict(zip(rows[0], rows[1], strict=True))
    assert (row["player"], row["round"]) == ("Alice", "1")
    assert row["dmg_to_Bob"] == "6"
    assert row["dmg_to_Carol"] == "3"
    assert row["round_combat_total"] == "9"


def test_turns_csv_leaves_a_players_own_column_blank(client):
    """Blank means "could not have happened"; 0 means "did not". A single zero
    for both would lose the difference."""
    _skirmish(client)
    _, rows = _turn_rows(client)
    row = dict(zip(rows[0], rows[1], strict=True))
    assert row["dmg_to_Alice"] == ""      # Alice's own row
    assert row["dmg_to_Dave"] == "0"      # at the table, took nothing from her


def test_turns_csv_is_byte_stable_across_exports(client):
    _skirmish(client)
    first, _ = _turn_rows(client)
    second, _ = _turn_rows(client)
    assert first.text == second.text


def test_turns_csv_is_offered_on_the_sheet(client):
    _skirmish(client)
    assert "/results/turns.csv" in client.get("/results").text


def test_the_sheet_shows_who_hit_whom(client):
    _skirmish(client)
    body = client.get("/results").text
    assert "Combat damage dealt, by opponent" in body

    matrix = body[body.index("Combat damage dealt, by opponent"):]
    matrix = matrix[:matrix.index("</table>")]
    cells = re.findall(r"<t[dh][^>]*>\s*([^<\s][^<]*?)\s*</t[dh]>", matrix)
    # Row totals (dealt) and the column totals (taken) must both appear and
    # must agree on the grand total, or the grid is lying about one margin.
    assert "23" in cells and "27" in cells
    assert cells.count("52") == 1


def test_the_matrix_is_omitted_when_nobody_connected(client):
    """An all-zero grid says less than no grid."""
    seat_table(client, "A", 1, ROSTER)
    record_turn(client, "Alice", round_no=1, attacking_creatures=2)
    body = client.get("/results").text
    assert "Match 1" in body
    assert "Combat damage dealt, by opponent" not in body


def test_the_matrix_survives_a_game_with_no_turns_at_all(client):
    """A table seated and then abandoned still renders a section."""
    seat_table(client, "A", 1, ROSTER)
    assert client.get("/results").status_code == 200
    assert client.get("/results/turns.csv").status_code == 200
