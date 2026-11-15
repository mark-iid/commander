"""Scoring verification against a known 4-player / 3-game sample.

Expected winners were computed independently and hand-checked. If you change the
scoring engine, these must still pass.
"""
import pathlib
import sys

import yaml

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.scoring import (  # noqa: E402
    GamePlayerStat,
    ScoringConfig,
    build_standings,
    leaderboard,
    ranked_standings,
)


def _config() -> ScoringConfig:
    cfg_path = pathlib.Path(__file__).resolve().parents[1] / "config" / "event.example.yaml"
    return ScoringConfig.from_dict(yaml.safe_load(cfg_path.read_text()))


# game_id, player, placement, final_life, combat, noncombat, cmdr, opp,
# big_dealt, big_taken, creatures, graveyard
_ROWS = [
    (1, "Alice", 1, 5, 40, 3, 12, 2, 15, 6, 5, 18),
    (1, "Bob", 2, -3, 22, 0, 0, 0, 12, 15, 3, 20),
    (1, "Carol", 3, -8, 10, 8, 0, 1, 8, 40, 2, 30),
    (1, "Dave", 4, -11, 5, 0, 0, 0, 4, 9, 1, 12),
    (2, "Alice", 4, -6, 9, 0, 0, 0, 7, 20, 2, 14),
    (2, "Bob", 1, 12, 35, 2, 21, 3, 30, 5, 4, 16),
    (2, "Carol", 2, -1, 18, 5, 0, 0, 11, 12, 3, 25),
    (2, "Dave", 3, -4, 14, 0, 0, 0, 9, 18, 2, 10),
    (3, "Alice", 2, 4, 20, 1, 0, 1, 13, 8, 3, 11),
    (3, "Bob", 3, -5, 16, 0, 6, 0, 10, 14, 2, 19),
    (3, "Carol", 1, 7, 28, 12, 0, 2, 22, 6, 9, 40),
    (3, "Dave", 4, -9, 6, 0, 0, 0, 5, 22, 1, 13),
]

_STATS = [
    GamePlayerStat(
        game_id=r[0], player=r[1], placement=r[2], final_life=r[3],
        combat_dmg_dealt=r[4], noncombat_dmg_dealt=r[5], cmdr_dmg_dealt=r[6],
        opps_eliminated=r[7], biggest_attack_dealt=r[8], biggest_attack_taken=r[9],
        most_creatures_in_attack=r[10], total_graveyard=r[11],
    )
    for r in _ROWS
]

_ROSTER = ["Alice", "Bob", "Carol", "Dave"]

# key -> (winner, value)
_EXPECTED = {
    # Bob and Carol tie on 9 win points, so the configured tiebreaker decides.
    # It is combat damage dealt: Bob 73, Carol 56 -> Bob.
    # This flipped when the event owner set the tiebreaker to combat-only. Under
    # the previous combat+non-combat rule Carol took it 81 to 75, because her 25
    # points of non-combat damage outweighed Bob's 17-point lead in combat. If
    # this assertion ever fails, check total_damage_fields in the config before
    # suspecting the scoring engine — the engine is generic and this expectation
    # is a function of that list.
    "technical_winner": ("Bob", 9),
    "blame_it_on_shuffling": ("Dave", 4),
    "does_nobody_block": ("Bob", 73),
    "no_apologies": ("Bob", 30),
    "you_should_see_the_other_guy": ("Carol", 40),
    "how_many_were_1_1s": ("Carol", 9),
    "cant_spell_million_without_mill": ("Carol", 40),
    "twenty_one_less_than_forty": ("Bob", 27),
    # Carol and Dave both dealt no commander damage; most combat breaks it, 56 to 25.
    "forty_more_than_twenty_one": ("Carol", 0),
    # Alice, Bob and Carol all eliminated 3; most combat breaks it: Bob 73, Alice 69,
    # Carol 56. Roster order gave this to Alice before every prize had a tiebreak.
    "assassin_or_asshole": ("Bob", 3),
    "scared_of_the_sword": ("Carol", 25),
}


def test_leaderboard_matches_expected():
    results = {r.key: (r.winner, r.value) for r in leaderboard(_STATS, _config(), _ROSTER)}
    assert results == _EXPECTED


def test_empty_event_has_no_winners():
    results = leaderboard([], _config(), _ROSTER)
    assert all(r.winner is None and r.value is None for r in results)


# --- unclaimed prizes --------------------------------------------------------
#
# The gap that let a real bug through: the sample above has a winner for
# everything, and the empty-event case has a winner for nothing. Neither
# exercises the case the projector actually spends round one in — games
# recorded, but nobody having done the thing a prize rewards.

def _flat(**overrides) -> list[GamePlayerStat]:
    """One complete game in which every stat is zero unless named."""
    return [
        GamePlayerStat(game_id=1, player=p, placement=i + 1, **overrides)
        for i, p in enumerate(_ROSTER)
    ]


def _by_key(stats) -> dict:
    return {r.key: (r.winner, r.value) for r in leaderboard(stats, _config(), _ROSTER)}


def test_max_prizes_are_unclaimed_while_the_field_is_on_zero():
    """Nobody milled a card, so nobody wins the mill prize.

    Awarding it anyway handed every "most X" prize to whoever sorted first,
    which after one round is simply the first name on the roster: the board read
    "9 of 11 claimed" with Alice's name on all nine.
    """
    results = _by_key(_flat())
    for key in (
        "does_nobody_block",
        "no_apologies",
        "you_should_see_the_other_guy",
        "how_many_were_1_1s",
        "cant_spell_million_without_mill",
        "twenty_one_less_than_forty",
        "assassin_or_asshole",
        "scared_of_the_sword",
    ):
        assert results[key] == (None, None), key


def test_min_prizes_still_award_at_zero():
    """The other half of the same rule. Zero is the best possible score for a
    `min` prize — "40 Is More Than 21" is *meant* to go to whoever dealt no
    commander damage at all, so it must not be swept up as unclaimed."""
    results = _by_key(_flat())
    winner, value = results["forty_more_than_twenty_one"]
    assert (winner, value) == ("Alice", 0)


def test_a_seated_player_who_has_not_played_is_not_a_contender():
    """The repository derives a row for everyone seated, before they have done
    anything. Zero is a winning score for a `min` prize, so a row that only
    means "sat down" must not count as a game played, or the first name on the
    roster wins "40 Is More Than 21" before a card is drawn."""
    seated = [
        GamePlayerStat(game_id=1, player=p, placement=None, played=False) for p in _ROSTER
    ]
    results = _by_key(seated)
    assert all(winner is None for winner, _ in results.values())


def test_a_max_prize_is_claimed_as_soon_as_one_player_scores():
    results = _by_key(
        [
            GamePlayerStat(game_id=1, player="Alice", placement=1),
            GamePlayerStat(game_id=1, player="Bob", placement=2, total_graveyard=7),
            GamePlayerStat(game_id=1, player="Carol", placement=3),
            GamePlayerStat(game_id=1, player="Dave", placement=4),
        ]
    )
    assert results["cant_spell_million_without_mill"] == ("Bob", 7)


def test_win_point_prizes_survive_a_partly_played_event():
    """Pod A has played, pod B has not. Only players with a game contend, so the
    wooden spoon must not go to somebody who has not sat down yet."""
    stats = [
        GamePlayerStat(game_id=1, player="Alice", placement=1, combat_dmg_dealt=10),
        GamePlayerStat(game_id=1, player="Bob", placement=2, combat_dmg_dealt=5),
    ]
    results = _by_key(stats)
    assert results["technical_winner"] == ("Alice", 4)
    assert results["blame_it_on_shuffling"] == ("Bob", 3)


def test_a_player_still_in_the_game_scores_no_win_points():
    """Mid-match is the normal state here, not an edge case: turns are recorded
    while placement is still NULL, which is exactly what lets the projected
    board stay live during a game. Read as anything but zero -- `or 1`, a
    default, a cast -- and every match would show win points nobody had earned
    yet, correcting itself only once the deaths were entered.

    The game and the damage still count. Only the placement points wait.
    """
    live = [
        GamePlayerStat(game_id=1, player="Alice", placement=None, combat_dmg_dealt=30),
        GamePlayerStat(game_id=1, player="Bob", placement=4, combat_dmg_dealt=1),
    ]
    by_player = {s.player: s for s in build_standings(live, _config(), _ROSTER)}
    assert by_player["Alice"].win_points == 0
    assert by_player["Alice"].games_played == 1
    assert by_player["Alice"].totals["combat_dmg_dealt"] == 30
    assert by_player["Bob"].win_points == 1
    # So the wooden spoon sits with the player yet to finish, not the one who
    # has: a `min` prize on zero is a real win (see test_min_prizes_still_award).
    assert _by_key(live)["blame_it_on_shuffling"] == ("Alice", 0)


def test_tiebreak_beats_roster_order_but_roster_order_is_the_last_resort():
    tied = [
        GamePlayerStat(game_id=1, player="Alice", placement=1, combat_dmg_dealt=10),
        GamePlayerStat(game_id=1, player="Bob", placement=1, combat_dmg_dealt=30),
        GamePlayerStat(game_id=1, player="Carol", placement=1, combat_dmg_dealt=30),
    ]
    # Bob and Carol are level on win points; Bob wins on damage over Alice, and
    # over Carol only because the roster puts him first.
    assert _by_key(tied)["technical_winner"] == ("Bob", 4)


def test_does_nobody_block_ties_go_to_the_most_creatures_attacked_with():
    """Level on damage, whoever sent more creatures over the whole night wins.
    Bob has the bigger single swing and sorts after Alice, so neither a peak
    reading nor roster order picks Alice: only the night total does."""
    tied = [
        GamePlayerStat(game_id=1, player="Alice", placement=1, combat_dmg_dealt=10,
                       most_creatures_in_attack=3, creatures_attacked_with=4),
        GamePlayerStat(game_id=2, player="Alice", placement=1, combat_dmg_dealt=10,
                       most_creatures_in_attack=3, creatures_attacked_with=4),
        GamePlayerStat(game_id=1, player="Bob", placement=2, combat_dmg_dealt=20,
                       most_creatures_in_attack=5, creatures_attacked_with=5),
        GamePlayerStat(game_id=1, player="Carol", placement=3, combat_dmg_dealt=20,
                       most_creatures_in_attack=1, creatures_attacked_with=9),
    ]
    assert _by_key(tied)["does_nobody_block"] == ("Carol", 20)


def test_you_should_see_the_other_guy_ties_go_to_the_most_damage_taken():
    tied = [
        GamePlayerStat(game_id=1, player="Alice", placement=1, biggest_attack_taken=8,
                       combat_dmg_taken=8),
        GamePlayerStat(game_id=1, player="Bob", placement=2, biggest_attack_taken=8,
                       combat_dmg_taken=19),
    ]
    assert _by_key(tied)["you_should_see_the_other_guy"] == ("Bob", 8)


def test_the_mill_prize_ties_go_to_the_most_win_points():
    tied = [
        GamePlayerStat(game_id=1, player="Alice", placement=4, total_graveyard=30),
        GamePlayerStat(game_id=1, player="Bob", placement=1, total_graveyard=30),
    ]
    assert _by_key(tied)["cant_spell_million_without_mill"] == ("Bob", 30)


def test_scared_of_the_sword_ties_go_to_the_least_combat_damage():
    tied = [
        GamePlayerStat(game_id=1, player="Alice", placement=1, noncombat_dmg_dealt=6,
                       combat_dmg_dealt=30),
        GamePlayerStat(game_id=1, player="Bob", placement=2, noncombat_dmg_dealt=6,
                       combat_dmg_dealt=2),
    ]
    assert _by_key(tied)["scared_of_the_sword"] == ("Bob", 6)


def test_every_configured_tiebreak_names_a_real_stat():
    """An unknown field reads as zero for everyone, so a typo in event.yaml would
    quietly turn a tiebreak back into roster order."""
    from app.scoring import _SUMMABLE

    known = {"total_damage", "win_points", *_SUMMABLE}
    for prize in _config().prizes:
        assert prize.tiebreak is not None, prize.key
        assert prize.tiebreak.field in known, prize.key


# --- players who cannot win a prize -----------------------------------------

def _excluding(*names) -> ScoringConfig:
    import dataclasses

    return dataclasses.replace(_config(), prize_ineligible=names)


def test_a_lone_ineligible_name_without_brackets_is_that_name():
    """`prize_ineligible: Jesse` is easy to write. Iterated as a string it
    excluded the letters J, e and s, and Jesse could win again."""
    cfg_path = pathlib.Path(__file__).resolve().parents[1] / "config" / "event.example.yaml"
    raw = yaml.safe_load(cfg_path.read_text())
    raw["scoring"]["prize_ineligible"] = "Jesse"
    assert ScoringConfig.from_dict(raw).prize_ineligible == ("Jesse",)


def test_an_ineligible_player_hands_every_prize_to_the_runner_up():
    """Alice wins every prize in this game; excluded, each goes to the next in line."""
    stats = [
        GamePlayerStat(game_id=1, player="Alice", placement=1, combat_dmg_dealt=40,
                       opps_eliminated=3),
        GamePlayerStat(game_id=1, player="Bob", placement=2, combat_dmg_dealt=10,
                       opps_eliminated=1),
        GamePlayerStat(game_id=1, player="Carol", placement=3, combat_dmg_dealt=5),
    ]
    won = {r.key: (r.winner, r.value) for r in leaderboard(stats, _excluding("Alice"), _ROSTER)}
    assert won["technical_winner"] == ("Bob", 3)
    assert won["does_nobody_block"] == ("Bob", 10)
    assert won["assassin_or_asshole"] == ("Bob", 1)
    assert "Alice" not in {winner for winner, _ in won.values()}


def test_a_runner_up_on_zero_leaves_the_prize_unclaimed():
    """Only Alice eliminated anyone. The next in line has 0, and a `max` prize on
    0 is unclaimed rather than handed to whoever sorts first."""
    stats = [
        GamePlayerStat(game_id=1, player="Alice", placement=1, opps_eliminated=3),
        GamePlayerStat(game_id=1, player="Bob", placement=2),
    ]
    won = {r.key: (r.winner, r.value) for r in leaderboard(stats, _excluding("Alice"), _ROSTER)}
    assert won["assassin_or_asshole"] == (None, None)


def test_an_ineligible_player_still_tops_the_standings():
    stats = [
        GamePlayerStat(game_id=1, player="Alice", placement=1),
        GamePlayerStat(game_id=1, player="Bob", placement=2),
    ]
    ranked = ranked_standings(build_standings(stats, _excluding("Alice"), _ROSTER))
    assert ranked[0] == (1, ranked[0][1]) and ranked[0][1].player == "Alice"


# --- ranked_standings --------------------------------------------------------

def test_ties_share_a_rank_and_consume_the_places_below():
    stats = [
        GamePlayerStat(game_id=1, player="Alice", placement=1, combat_dmg_dealt=10),
        GamePlayerStat(game_id=1, player="Bob", placement=2, combat_dmg_dealt=7),
        GamePlayerStat(game_id=1, player="Carol", placement=2, combat_dmg_dealt=7),
        GamePlayerStat(game_id=1, player="Dave", placement=4, combat_dmg_dealt=1),
    ]
    standings = build_standings(stats, _config(), _ROSTER)
    assert [(rank, s.player) for rank, s in ranked_standings(standings)] == [
        (1, "Alice"),
        (2, "Bob"),
        (2, "Carol"),   # level on points AND damage -> joint second
        (4, "Dave"),    # third place is consumed by the tie
    ]


def test_players_yet_to_play_are_all_level_at_the_bottom():
    stats = [GamePlayerStat(game_id=1, player="Alice", placement=1)]
    ranked = ranked_standings(build_standings(stats, _config(), _ROSTER))
    assert ranked[0][0] == 1
    assert [rank for rank, _ in ranked[1:]] == [2, 2, 2]
