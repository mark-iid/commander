"""Entry surface: rendering, validation, and persistence.

Each test gets a fresh SQLite file and a copy of the example config, seeded
through the app's own startup path.

The surface has two forms now, matching the event owner's tracking sheet: a turn
form saved many times during a match, and a death/win form saved once. The split
is the point — see test_a_turn_saves_with_no_placement_anywhere.
"""
import pathlib
import re
import shutil
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import STAT_MAX  # noqa: E402
from app.repository import ValueTooWideForStorage  # noqa: E402
from tests.helpers import record_final, record_turn, seat_table  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
ROSTER = ["Alice", "Bob", "Carol", "Dave"]

# A turn with something in every box. Alice's opponents are seats 1..3 of
# (Bob, Carol, Dave), so dmg_1 is Bob.
_TURN = {
    "pod": "A",
    "match_no": "1",
    "player": "Alice",
    "round_no": "1",
    "attacking_creatures": "5",
    "cmdr_dmg_dealt": "12",
    "noncombat_dmg_dealt": "3",
    "opps_eliminated": "2",
    "dmg_1": "40",
    "dmg_2": "0",
    "dmg_3": "0",
}

_FINAL = {
    "pod": "A",
    "match_no": "1",
    "player": "Alice",
    "round_no": "1",
    "placement": "1",
    "final_life": "5",
    "total_graveyard": "18",
}

PASSCODE = "test-passcode"


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A signed-in tracker at an already-seated table. Auth itself is covered in
    tests/test_auth.py; these tests are about the entry surface behind it."""
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


def _storage(client):
    return db.get_storage()


def _event_id(client):
    return app.state.event_id


def _stat(client, player="Alice", pod="A", match=1):
    """One player's derived per-game record."""
    storage = _storage(client)
    game_id = storage.find_game(_event_id(client), pod, match)
    return storage.stat_for(game_id, player)


def _showing(response) -> tuple[str, int]:
    """(player, round) the turn form is open on. Read off the form's own data
    attributes rather than its heading, which is styled for a person."""
    m = re.search(r'id="turn-form"[^>]*data-player="([^"]*)" data-round="(\d+)"', response.text)
    assert m, "no turn form in the response"
    return m.group(1), int(m.group(2))


def _finished(client):
    return [s for s in _storage(client).all_stats(_event_id(client))
            if s.placement is not None]


# --- seating ----------------------------------------------------------------

def test_an_unseated_table_asks_who_is_playing(client):
    r = client.get("/entry", params={"pod": "B", "match_no": 3})
    assert r.status_code == 200
    assert "who is playing?" in r.text
    assert "This table has not been set yet." in r.text


def test_seating_a_table_records_turn_order(client):
    storage = _storage(client)
    game_id = storage.find_game(_event_id(client), "A", 1)
    assert storage.seating(game_id) == ROSTER


def test_a_player_cannot_be_seated_at_two_pods_in_one_match(client):
    """Two rows for one match would quietly double their win points."""
    r = client.post("/entry/seat", data={"pod": "B", "match_no": "1",
                                         "seat": ["Alice", "Bob", "Carol", "Dave"]})
    assert r.status_code == 422
    assert "already seated at another pod this match" in r.text


def test_the_same_players_may_be_reseated_for_a_later_match(client):
    """Seating rotates, but a full rotation is the event owner's business —
    nothing stops the same four sitting down again for match 2."""
    r = client.post("/entry/seat", data={"pod": "A", "match_no": "2",
                                         "seat": ["Alice", "Bob", "Carol", "Dave"]})
    assert r.status_code == 200


def test_a_short_table_is_refused(client):
    r = client.post("/entry/seat", data={"pod": "B", "match_no": "2",
                                         "seat": ["Alice", "Bob"]})
    assert r.status_code == 422
    assert "a table seats 4" in r.text


# --- rendering --------------------------------------------------------------

def test_index_renders_selectors_and_the_seated_table(client):
    r = client.get("/entry")
    assert r.status_code == 200
    body = r.text
    for name in ROSTER:
        assert name in body
    assert 'name="pod"' in body
    assert 'name="match_no"' in body
    assert 'name="round_no"' in body
    assert 'name="placement"' in body
    assert 'name="total_graveyard"' in body


def test_the_damage_grid_offers_only_the_other_players_at_the_table(client):
    """The whole reason for the grid over a single combat-damage box: a
    spreadsheet has to show all eight players, the app knows the three."""
    body = client.get("/entry", params={"pod": "A", "match_no": 1, "player": "Alice"}).text
    grid = body[body.index("Combat damage to"):body.index("Rest of the turn")]
    assert "Bob" in grid and "Carol" in grid and "Dave" in grid
    assert "Alice" not in grid, "a player cannot deal combat damage to themselves"
    assert grid.count('type="number"') == 3


def test_index_defaults_to_first_valid_selection(client):
    r = client.get("/entry", params={"pod": "Z", "match_no": 99, "player": "Nobody"})
    assert r.status_code == 200
    assert "Pod A · Match 1" in r.text
    assert _showing(r) == ("Alice", 1)


def test_form_partial_is_not_a_full_page(client):
    r = client.get("/entry/form", params={"pod": "A", "match_no": 1, "player": "Carol"})
    assert r.status_code == 200
    assert "<!doctype html>" not in r.text.lower()
    assert 'id="entry-panel"' in r.text
    # pod table rides along out-of-band
    assert 'hx-swap-oob="true"' in r.text
    assert _showing(r) == ("Carol", 1)


# --- saving turns -----------------------------------------------------------

def test_a_turn_saves_with_no_placement_anywhere(client):
    """The bug this redesign exists for.

    Placement used to be required on every save, so a tracker three turns into a
    game — who cannot know the finishing order yet — could not record anything
    at all. A turn now saves on its own.
    """
    r = client.post("/entry/turn", data=_TURN)
    assert r.status_code == 200
    assert "has-errors" not in r.text

    s = _stat(client)
    assert s.placement is None
    assert s.combat_dmg_dealt == 40


def test_a_turn_persists_every_field(client):
    assert client.post("/entry/turn", data=_TURN).status_code == 200
    s = _stat(client)
    assert s.combat_dmg_dealt == 40
    assert s.cmdr_dmg_dealt == 12
    assert s.noncombat_dmg_dealt == 3
    assert s.opps_eliminated == 2
    assert s.most_creatures_in_attack == 5


def test_damage_is_attributed_to_the_named_opponent(client):
    """dmg_1 is Bob, so Bob — and only Bob — takes it."""
    client.post("/entry/turn", data={**_TURN, "dmg_1": "9", "dmg_2": "4", "dmg_3": ""})
    assert _stat(client, "Bob").biggest_attack_taken == 9
    assert _stat(client, "Carol").biggest_attack_taken == 4
    assert _stat(client, "Dave").biggest_attack_taken == 0


def test_totals_and_peaks_are_derived_across_turns(client):
    """Sums for totals, maxima for peaks — and no tracker types either."""
    record_turn(client, "Alice", round_no=1, damage={1: 5, 2: 3}, attacking_creatures=2)
    record_turn(client, "Alice", round_no=2, damage={1: 12}, attacking_creatures=7)

    s = _stat(client)
    assert s.combat_dmg_dealt == 20                 # 5 + 3 + 12
    assert s.biggest_attack_dealt == 12             # best single turn's total, 8 vs 12
    assert s.most_creatures_in_attack == 7          # max, not sum
    assert s.creatures_attacked_with == 9           # the tiebreak's sum, 2 + 7


def test_damage_taken_is_summed_across_attackers_and_turns(client):
    """Bob is dmg_1 for Alice, and Alice is dmg_1 for Carol."""
    record_turn(client, "Alice", round_no=1, damage={1: 5})
    record_turn(client, "Alice", round_no=2, damage={1: 4})
    record_turn(client, "Carol", round_no=1, damage={2: 6})   # Carol's dmg_2 is Bob

    bob = _stat(client, "Bob")
    assert bob.combat_dmg_taken == 15                # 5 + 4 + 6
    assert bob.biggest_attack_taken == 6             # still one attack's worth
    assert _stat(client, "Alice").combat_dmg_taken == 0


def test_save_creates_exactly_one_game_per_pod_and_match(client):
    client.post("/entry/turn", data=_TURN)
    client.post("/entry/turn", data={**_TURN, "player": "Bob"})

    storage = _storage(client)
    game_id = storage.find_game(_event_id(client), "A", 1)
    assert game_id is not None
    assert {s.player for s in storage.stats_for_game(game_id)} == set(ROSTER)


def test_resaving_a_turn_updates_rather_than_duplicates(client):
    client.post("/entry/turn", data=_TURN)
    r = client.post("/entry/turn", data={**_TURN, "dmg_1": "55"})
    assert r.status_code == 200
    assert _stat(client).combat_dmg_dealt == 55


def test_a_correction_that_clears_a_cell_removes_the_damage(client):
    """Blanking a cell has to delete the row, not leave the old value behind."""
    client.post("/entry/turn", data={**_TURN, "dmg_1": "40", "dmg_2": "7"})
    assert _stat(client).combat_dmg_dealt == 47
    client.post("/entry/turn", data={**_TURN, "dmg_1": "40", "dmg_2": ""})
    assert _stat(client).combat_dmg_dealt == 40


def test_blank_turn_fields_are_zero(client):
    sparse = {"pod": "A", "match_no": "1", "player": "Dave", "round_no": "1"}
    sparse.update({k: "" for k in _TURN if k not in sparse})
    r = client.post("/entry/turn", data=sparse)
    assert r.status_code == 200
    s = _stat(client, "Dave")
    assert s.combat_dmg_dealt == 0 and s.cmdr_dmg_dealt == 0


def test_saving_advances_to_the_next_seat(client):
    """A tracker walking the table taps Save and lands on whoever plays next."""
    r = client.post("/entry/turn", data=_TURN)
    assert _showing(r) == ("Bob", 1)


def test_saving_the_last_seat_advances_the_round(client):
    r = client.post("/entry/turn", data={**_TURN, "player": "Dave", "round_no": "3"})
    assert _showing(r) == ("Alice", 4)
    # The round box itself, not merely a 4 somewhere on the page.
    box = re.search(r'name="round_no"[^>]*value="(\d+)"', r.text)
    assert box and box.group(1) == "4"


def test_a_saved_turn_prefills_the_form(client):
    client.post("/entry/turn", data=_TURN)
    r = client.get("/entry/form", params={"pod": "A", "match_no": 1,
                                          "player": "Alice", "round_no": 1})
    assert 'value="40"' in r.text            # the damage cell came back
    assert "Editing round 1" in r.text


# --- saving the death/win section -------------------------------------------

def test_the_final_section_persists(client):
    r = client.post("/entry/final", data=_FINAL)
    assert r.status_code == 200
    s = _stat(client)
    assert (s.placement, s.final_life, s.total_graveyard) == (1, 5, 18)


def test_a_blank_placement_means_still_playing(client):
    r = client.post("/entry/final", data={**_FINAL, "placement": ""})
    assert r.status_code == 200
    assert "Still playing" in r.text
    assert _stat(client).placement is None


def test_the_pod_table_counts_finished_players_not_seated_ones(client):
    """Every seated player has a row from the moment the table is set, so
    counting rows would read "4 of 4" before a card was played."""
    body = client.get("/entry").text
    assert "0 of 4 finished" in body

    record_final(client, "Alice", 1)
    assert "1 of 4 finished" in client.get("/entry").text


def test_tied_placements_are_allowed(client):
    """Confirmed rule: tied players each take the full placement score."""
    assert record_final(client, "Alice", 2).status_code == 200
    assert record_final(client, "Bob", 2).status_code == 200
    assert len(_finished(client)) == 2


def test_negative_final_life_is_valid(client):
    r = client.post("/entry/final", data={**_FINAL, "final_life": "-11"})
    assert r.status_code == 200
    assert _stat(client).final_life == -11


# --- validation -------------------------------------------------------------

@pytest.mark.parametrize(
    "override, expected_field",
    [
        ({"player": "Mallory"}, "player"),
        ({"pod": "Z"}, "pod"),
        ({"match_no": "7"}, "match_no"),
        ({"round_no": "0"}, "round_no"),
        ({"cmdr_dmg_dealt": "-5"}, "cmdr_dmg_dealt"),
        ({"cmdr_dmg_dealt": "abc"}, "cmdr_dmg_dealt"),
        ({"dmg_1": "-5"}, "dmg_1"),
        ({"dmg_1": "abc"}, "dmg_1"),
    ],
)
def test_invalid_turns_are_rejected(client, override, expected_field):
    r = client.post("/entry/turn", data={**_TURN, **override})
    assert r.status_code == 422
    assert "has-errors" in r.text
    assert expected_field in r.text
    assert _stat(client).combat_dmg_dealt == 0


@pytest.mark.parametrize("override, expected_field",
                         [({"placement": "9"}, "placement"), ({"pod": "Z"}, "pod")])
def test_invalid_finals_are_rejected(client, override, expected_field):
    r = client.post("/entry/final", data={**_FINAL, **override})
    assert r.status_code == 422
    assert expected_field in r.text
    assert _finished(client) == []


def test_a_blank_number_is_reported_in_words_a_tracker_understands(client):
    """pydantic says "Input should be a valid integer, unable to parse string as
    an integer", which tells a tracker on a phone nothing about which box."""
    r = client.post("/entry/turn", data={**_TURN, "cmdr_dmg_dealt": "abc"})
    assert r.status_code == 422
    assert "whole numbers only" in r.text
    assert "unable to parse string as an integer" not in r.text


def test_rejected_submission_keeps_what_was_typed(client):
    r = client.post("/entry/turn", data={**_TURN, "cmdr_dmg_dealt": "abc"})
    assert r.status_code == 422
    # the tracker's other numbers survive the round trip
    assert 'value="40"' in r.text
    assert 'value="5"' in r.text


# --- SSE hand-off -----------------------------------------------------------

def test_save_publishes_to_the_broadcaster(client):
    import asyncio

    from app.events import broadcaster

    received: list[str] = []

    async def listen():
        agen = broadcaster.subscribe()
        task = asyncio.create_task(agen.__anext__())
        await asyncio.sleep(0)  # let the subscriber register
        client.post("/entry/turn", data=_TURN)
        received.append(await asyncio.wait_for(task, timeout=2))
        await agen.aclose()

    asyncio.run(listen())
    assert received == ["stats-updated"]


# --- KG-10: unbounded integers used to 500 and silently drop the row -----------
#
# Before this bound, a wide value cleared pydantic and every config check, then
# raised OverflowError inside the repository *before* the INSERT. The tracker saw
# nothing: base.html does not swap 5xx, so the panel simply failed to update —
# indistinguishable from a slow save, with the row never written.

@pytest.mark.parametrize("field", ["cmdr_dmg_dealt", "attacking_creatures", "dmg_1"])
@pytest.mark.parametrize("value", ["9" * 19, "9" * 20, str(2**63), str(STAT_MAX + 1)])
def test_oversized_turn_stat_is_refused_at_the_field(client, field, value):
    r = client.post("/entry/turn", data={**_TURN, field: value})
    assert r.status_code == 422, f"{field}={value[:8]}... should be a field error, not a crash"
    assert "has-errors" in r.text
    assert field in r.text
    assert _stat(client).combat_dmg_dealt == 0


@pytest.mark.parametrize("field", ["final_life", "total_graveyard"])
@pytest.mark.parametrize("value", ["9" * 19, str(2**63), str(STAT_MAX + 1)])
def test_oversized_final_stat_is_refused_at_the_field(client, field, value):
    r = client.post("/entry/final", data={**_FINAL, field: value})
    assert r.status_code == 422
    assert field in r.text
    assert _finished(client) == []


def test_the_maximum_permitted_value_is_still_accepted(client):
    """The bound must reject what nobody can reach, not what somebody might."""
    r = client.post("/entry/turn", data={**_TURN, "dmg_1": str(STAT_MAX)})
    assert r.status_code == 200
    assert _stat(client).combat_dmg_dealt == STAT_MAX


def test_negative_life_is_bounded_but_still_negative(client):
    assert client.post("/entry/final",
                       data={**_FINAL, "final_life": str(-STAT_MAX)}).status_code == 200
    assert client.post("/entry/final",
                       data={**_FINAL, "final_life": str(-STAT_MAX - 1)}).status_code == 422


def test_storage_refuses_a_value_it_cannot_bind(client):
    """Defence in depth: the route bounds input, but any caller reaching the
    repository directly must not raise a driver error out of a write."""
    from app.models import TurnStat

    storage = db.get_storage()
    game_id = storage.find_game(app.state.event_id, "A", 1)
    with pytest.raises(ValueTooWideForStorage) as exc:
        storage.save_turn(game_id, "Alice", TurnStat(1, cmdr_dmg_dealt=2**63))
    assert exc.value.field == "cmdr_dmg_dealt"
    assert _stat(client, "Alice").cmdr_dmg_dealt == 0


def test_storage_refuses_a_damage_cell_it_cannot_bind(client):
    from app.models import TurnStat

    storage = db.get_storage()
    game_id = storage.find_game(app.state.event_id, "A", 1)
    with pytest.raises(ValueTooWideForStorage):
        storage.save_turn(game_id, "Alice", TurnStat(1, damage={"Bob": 2**63}))
    assert _stat(client, "Bob").biggest_attack_taken == 0


def test_a_player_cannot_damage_themselves_in_storage(client):
    from app.models import TurnStat

    storage = db.get_storage()
    game_id = storage.find_game(app.state.event_id, "A", 1)
    with pytest.raises(ValueError, match="themselves"):
        storage.save_turn(game_id, "Alice", TurnStat(1, damage={"Alice": 5}))


# --- htmx URLs must stay relative ---------------------------------------------
#
# Regression guard. url_for() returns an ABSOLUTE url built from the request, so
# behind a TLS-terminating proxy the app (seeing plain http) emitted
# http://host/... into a page served over https. Browsers block that as mixed
# content and report nothing, so every button on /entry and /admin silently did
# nothing. Templates use `url_for(...).path` for this reason.

@pytest.mark.parametrize("path", ["/entry", "/admin"])
def test_htmx_urls_are_relative_behind_a_tls_proxy(client, path):
    r = client.get(path, headers={"X-Forwarded-Proto": "https", "Host": "commander.example.org"})
    assert r.status_code == 200
    absolute = re.findall(r'hx-[a-z]+="(https?://[^"]*)"', r.text)
    assert not absolute, (
        f"{path} emitted absolute htmx URLs {absolute}; behind a TLS proxy these become "
        "mixed content and the browser drops the request silently"
    )


# --- landing where the tracker is, and staying there ------------------------

def _options(response) -> list[str]:
    """The player picker's option labels, whitespace-normalised."""
    select = re.search(r'<select name="player".*?</select>', response.text, re.S).group(0)
    return [" ".join(o.split()) for o in re.findall(r"<option[^>]*>(.*?)</option>", select, re.S)]


def test_opening_the_table_lands_on_whoever_is_next_up(client):
    """A reload used to land on seat 1 in the latest round, which after seat 1
    had played meant a turn that was already saved."""
    record_turn(client, "Alice", round_no=1)
    record_turn(client, "Bob", round_no=1)
    assert _showing(client.get("/entry", params={"pod": "A", "match_no": 1})) == ("Carol", 1)

    record_turn(client, "Carol", round_no=1)
    record_turn(client, "Dave", round_no=1)
    assert _showing(client.get("/entry")) == ("Alice", 2)


def test_every_panel_puts_the_tracker_in_the_address_bar(client):
    """So a reload, or a phone that dropped the tab, comes back to the same
    player and round instead of pod A, match 1, seat 1."""
    r = client.post("/entry/turn", data=_TURN)
    url = r.headers["HX-Replace-Url"]
    assert url == "/entry?pod=A&match_no=1&player=Bob&round_no=1"

    reloaded = client.get(url)
    assert _showing(reloaded) == ("Bob", 1)


def test_saving_skips_a_player_who_is_out(client):
    """Carol is out. Nobody takes her turns, so landing on her every lap made
    the tracker reselect by hand."""
    assert record_final(client, "Carol", 4).status_code == 200
    r = record_turn(client, "Bob", round_no=2)
    assert _showing(r) == ("Dave", 2)


def test_skipping_the_last_seat_still_starts_the_next_round(client):
    assert record_final(client, "Dave", 4).status_code == 200
    r = record_turn(client, "Carol", round_no=2)
    assert _showing(r) == ("Alice", 3)


def test_next_up_skips_a_player_who_is_out(client):
    assert record_final(client, "Alice", 4).status_code == 200
    assert _showing(client.get("/entry")) == ("Bob", 1)


def test_the_picker_marks_who_has_played_the_round_and_who_is_out(client):
    record_turn(client, "Alice", round_no=1)
    assert record_final(client, "Carol", 4).status_code == 200
    r = client.get("/entry/form", params={"pod": "A", "match_no": 1,
                                          "player": "Bob", "round_no": 1})
    assert _options(r) == ["Alice ✓", "Bob", "Carol · out (4th)", "Dave"]


def _round_options(response) -> list[str]:
    """The round picker's option labels. Scoped to the turn form, because the
    eliminations form above it carries selects of its own."""
    form = re.search(r'<form id="turn-form".*?</form>', response.text, re.S).group(0)
    select = re.search(r'<select name="round_no".*?</select>', form, re.S).group(0)
    return [" ".join(o.split())
            for o in re.findall(r"<option[^>]*>(.*?)</option>", select, re.S)]


def test_the_round_control_is_a_picker_not_a_box(client):
    """It moves the tracker rather than carrying data, like the player picker
    beside it -- and a mistyped round is now a round overwritten, because every
    box keeps itself as it is left."""
    body = client.get("/entry").text
    assert '<select name="round_no"' in body
    assert 'type="number" name="round_no"' not in body


def test_a_fresh_table_offers_only_the_first_round(client):
    assert _round_options(client.get("/entry")) == ["1"]


def test_the_picker_offers_the_rounds_played_and_the_next_one(client):
    record_turn(client, "Alice", round_no=1)
    record_turn(client, "Alice", round_no=2)
    r = client.get("/entry/form", params={"pod": "A", "match_no": 1,
                                          "player": "Alice", "round_no": 1})
    # Nothing past the next round: skipping ahead is what leaves a gap.
    assert _round_options(r) == ["1 ✓", "2 ✓", "3"]


def test_the_picker_marks_only_the_rounds_this_player_entered(client):
    record_turn(client, "Alice", round_no=1)
    r = client.get("/entry/form", params={"pod": "A", "match_no": 1,
                                          "player": "Bob", "round_no": 1})
    assert _round_options(r) == ["1", "2"]


def test_a_round_from_the_url_is_still_offered(client):
    """Otherwise the picker would not contain the round the panel is open on,
    the browser would show the first option instead, and the next save would go
    to round 1 -- a stale link silently retargeted."""
    record_turn(client, "Alice", round_no=1)
    r = client.get("/entry/form", params={"pod": "A", "match_no": 1,
                                          "player": "Alice", "round_no": 20})
    assert "20" in _round_options(r)
    assert _showing(r) == ("Alice", 20)


def test_editing_a_saved_turn_says_so(client):
    """Editing overwrites, so it is called out; a new round is not."""
    client.post("/entry/turn", data=_TURN)
    editing = client.get("/entry/form", params={"pod": "A", "match_no": 1,
                                                "player": "Alice", "round_no": 1})
    assert 'class="badge warn">Editing round 1' in editing.text
    fresh = client.get("/entry/form", params={"pod": "A", "match_no": 1,
                                              "player": "Bob", "round_no": 1})
    assert "New round 1" in fresh.text


# --- the death/win section --------------------------------------------------

def _selected_placement(response) -> str | None:
    select = re.search(r'<select name="placement">.*?</select>', response.text, re.S).group(0)
    m = re.search(r'<option value="([^"]*)"\s*selected', select)
    return m.group(1) if m else None


def test_the_finish_suggests_the_next_place_out(client):
    """Placement is the order players go out, so the next one out takes the
    place equal to how many are still in."""
    r = client.get("/entry/form", params={"pod": "A", "match_no": 1, "player": "Alice"})
    assert _selected_placement(r) == "4"

    assert record_final(client, "Dave", 4).status_code == 200
    r = client.get("/entry/form", params={"pod": "A", "match_no": 1, "player": "Alice"})
    assert _selected_placement(r) == "3"


def test_a_recorded_placement_is_shown_rather_than_a_suggestion(client):
    assert record_final(client, "Dave", 2).status_code == 200
    r = client.get("/entry/form", params={"pod": "A", "match_no": 1, "player": "Dave"})
    assert _selected_placement(r) == "2"
    assert "Finished 2nd" in r.text


def test_recording_a_finish_goes_back_to_the_game(client):
    """A death is usually recorded mid-way through somebody else's turn."""
    record_turn(client, "Alice", round_no=1)
    r = record_final(client, "Bob", 4)
    assert r.status_code == 200
    assert "Bob finished 4th" in r.text
    assert _showing(r) == ("Carol", 1)


def test_a_finish_with_no_placement_stays_on_the_player(client):
    r = client.post("/entry/final", data={**_FINAL, "placement": ""})
    assert _showing(r)[0] == "Alice"


def test_the_finish_section_is_closed_until_it_has_an_error(client):
    r = client.get("/entry")
    assert '<details class="card final">' in r.text

    r = client.post("/entry/final", data={**_FINAL, "final_life": "dead"})
    assert r.status_code == 422
    assert '<details class="card final" open>' in r.text


def test_final_life_can_be_typed_negative_on_a_phone(client):
    """iOS's numeric keypad has no minus key, and life at death is usually
    negative. Every other box wants that keypad; this one must not ask for it."""
    r = client.get("/entry")
    box = re.search(r'<input[^>]*name="final_life"[^>]*>', r.text).group(0)
    assert "inputmode" not in box
    assert 'type="number"' in box


# --- the turn grid ----------------------------------------------------------

def test_a_turn_grid_cell_opens_that_turn(client):
    record_turn(client, "Alice", round_no=1, damage={1: 6})
    record_turn(client, "Alice", round_no=2)
    body = client.get("/entry").text
    grid = body[body.index('class="turn-grid"'):]
    assert ('hx-get="/entry/form?pod=A&amp;match_no=1&amp;player=Alice&amp;round_no=1"'
            in grid)
    # A missing turn opens too: it is the cell most worth tapping.
    assert ('hx-get="/entry/form?pod=A&amp;match_no=1&amp;player=Bob&amp;round_no=2"'
            in grid)


def test_every_page_carries_the_failed_request_banner(client):
    assert 'id="request-failed"' in client.get("/entry").text


@pytest.mark.parametrize("field, value, message", [
    ("noncombat_dmg_dealt", str(STAT_MAX + 1), f"at most {STAT_MAX}"),
    ("round_no", "0", "at least 1"),
])
def test_out_of_range_is_said_plainly(client, field, value, message):
    r = client.post("/entry/turn", data={**_TURN, field: value})
    assert r.status_code == 422
    assert message in r.text
    assert "Input should be" not in r.text


def test_commander_damage_has_to_be_in_the_combat_grid_too(client):
    """The likeliest honest slip: typing commander damage only in its own box,
    which leaves combat damage short for every prize and tiebreak built on it."""
    r = client.post("/entry/turn", data={**_TURN, "cmdr_dmg_dealt": "9",
                                         "dmg_1": "", "dmg_2": "", "dmg_3": ""})
    assert r.status_code == 422
    assert "add it to the grid too" in r.text
    assert _storage(client).stat_for(1, "Alice").played is False

    # Spread across two opponents, it still fits inside the grid's total.
    ok = client.post("/entry/turn", data={**_TURN, "cmdr_dmg_dealt": "9",
                                          "dmg_1": "4", "dmg_2": "5", "dmg_3": ""})
    assert ok.status_code == 200


def test_cannot_eliminate_more_opponents_than_the_table_has(client):
    r = client.post("/entry/turn", data={**_TURN, "opps_eliminated": "4"})
    assert r.status_code == 422
    assert "only 3 opponents at this table" in r.text


@pytest.mark.parametrize("path, form", [("/entry/turn", _TURN), ("/entry/final", _FINAL)])
def test_an_absurd_match_number_is_refused_rather_than_a_500(client, path, form):
    r = client.post(path, data={**form, "match_no": "99999999999999999999"})
    assert r.status_code == 422
