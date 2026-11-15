"""Shared seeding helpers for the HTTP-level tests.

Recording a game got wordier when the granularity went from one row per player
per game to one row per player per TURN: a table has to be seated, then turns
saved, then the death/win section. Most tests do not care about any of that --
they care that Alice ends the game with 40 combat damage and second place -- so
these helpers take the per-game numbers a test wants and produce the turns that
add up to them.

`record_stat` puts a player's whole combat damage on a single turn against a
single opponent. That is a real, legal game state, and it keeps the derived
peaks predictable: biggest_attack_dealt equals the combat total, and the target
takes exactly that much as their biggest_attack_taken.
"""
from __future__ import annotations

DEFAULT_SEATING = ("Alice", "Bob", "Carol", "Dave")


def _roster():
    from app import db
    from app.main import app

    return db.get_storage().roster(app.state.event_id)


def default_seating(player=None, size=4):
    """The first `size` players on the live roster, with `player` guaranteed a
    seat. Tests that install their own roster (the reset tests do) would
    otherwise try to seat four names that no longer exist."""
    names = _roster()[:size]
    if player is not None and player not in names:
        names = [player] + [n for n in names if n != player][: size - 1]
    return names


def seat_table(client, pod="A", match=1, names=None):
    """Set who is at a table. Creates the game if it does not exist yet."""
    names = names or default_seating()
    response = client.post(
        "/entry/seat",
        # A list value, not a list of (key, value) pairs: httpx silently drops
        # the latter, which reads as an empty form on the server.
        data={"pod": pod, "match_no": str(match), "seat": list(names)},
    )
    assert response.status_code == 200, response.text[:800]
    return response


def record_turn(client, player, *, pod="A", match=1, round_no=1, damage=None, **fields):
    """Save one turn cycle. `damage` maps a seat number (1-based, among that
    player's opponents) to combat damage."""
    payload = {
        "pod": pod,
        "match_no": str(match),
        "player": player,
        "round_no": str(round_no),
        "attacking_creatures": str(fields.get("attacking_creatures", 0)),
        "cmdr_dmg_dealt": str(fields.get("cmdr_dmg_dealt", 0)),
        "noncombat_dmg_dealt": str(fields.get("noncombat_dmg_dealt", 0)),
        "opps_eliminated": str(fields.get("opps_eliminated", 0)),
    }
    for seat, value in (damage or {}).items():
        payload[f"dmg_{seat}"] = str(value)
    return client.post("/entry/turn", data=payload)


def record_final(client, player, placement=None, *, pod="A", match=1,
                 final_life=0, total_graveyard=0):
    """Save the death/win section. A None placement means "still playing"."""
    return client.post("/entry/final", data={
        "pod": pod,
        "match_no": str(match),
        "player": player,
        "round_no": "1",
        "placement": "" if placement is None else str(placement),
        "final_life": str(final_life),
        "total_graveyard": str(total_graveyard),
    })


def record_stat(client, player, placement=None, *, pod="A", match=1, round_no=1,
                combat_dmg_dealt=0, noncombat_dmg_dealt=0, cmdr_dmg_dealt=0,
                opps_eliminated=0, attacking_creatures=0,
                final_life=0, total_graveyard=0, seating=None):
    """One player's whole game, expressed as the per-game numbers a test wants.

    Seats the table first if it is not already set, so a test can call this
    without knowing that seating exists.
    """
    if not _is_seated(client, pod, match):
        seat_table(client, pod, match, seating or default_seating(player))

    response = record_turn(
        client, player, pod=pod, match=match, round_no=round_no,
        attacking_creatures=attacking_creatures,
        cmdr_dmg_dealt=cmdr_dmg_dealt,
        noncombat_dmg_dealt=noncombat_dmg_dealt,
        opps_eliminated=opps_eliminated,
        damage={1: combat_dmg_dealt} if combat_dmg_dealt else None,
    )
    assert response.status_code == 200, response.text[:800]

    if placement is not None or final_life or total_graveyard:
        response = record_final(
            client, player, placement, pod=pod, match=match,
            final_life=final_life, total_graveyard=total_graveyard,
        )
        assert response.status_code == 200, response.text[:800]
    return response


def _is_seated(client, pod, match) -> bool:
    from app import db
    from app.main import app

    storage = db.get_storage()
    game_id = storage.find_game(app.state.event_id, pod, match)
    return game_id is not None and bool(storage.seating(game_id))
