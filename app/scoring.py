"""Scoring engine — pure functions, no I/O, no framework imports.

Given a list of per-player-per-game stat records and an event config, computes
standings and resolves every prize to a winner. Config-driven: prizes are data,
not code (see config/event.example.yaml).

Verified against a known 4-player / 3-game sample in tests/test_scoring.py.
"""
from __future__ import annotations

from collections.abc import Collection, Iterable
from dataclasses import dataclass, field
from typing import Literal

# --- Inputs -----------------------------------------------------------------

@dataclass(frozen=True)
class GamePlayerStat:
    """One player's whole game, as the scoring engine sees it.

    No longer one stored row: the repository derives this by aggregating
    turn_stats and turn_damage (sums for the totals, maxima for the peaks) and
    joining the death/win values from game_player_stats. Keeping that assembly
    in the repository is what lets the granularity change from per-game to
    per-turn without touching a line of scoring logic.

    `placement` is None until the player is out of the game. build_standings
    reads it through placement_points.get(), so an unfinished game scores zero
    win points while its damage still counts toward the damage prizes -- which
    is what keeps the projected leaderboard live mid-match.

    `played` is False for a player who is seated but has nothing recorded yet:
    no turn, no hit taken, no death/win entry. The repository still derives a
    row for them so the pod table can list the whole table, but sitting down is
    not playing, and build_standings does not count it as a game.
    """
    game_id: int
    player: str
    placement: int | None  # 1..4, or None while the game is still running
    final_life: int = 0
    combat_dmg_dealt: int = 0
    noncombat_dmg_dealt: int = 0
    cmdr_dmg_dealt: int = 0
    opps_eliminated: int = 0
    biggest_attack_dealt: int = 0
    biggest_attack_taken: int = 0
    most_creatures_in_attack: int = 0
    total_graveyard: int = 0
    # Night totals that only tiebreaks read: what reached this player, and
    # every creature they declared as an attacker, summed over their turns.
    combat_dmg_taken: int = 0
    creatures_attacked_with: int = 0
    played: bool = True


@dataclass(frozen=True)
class Tiebreak:
    field: str                    # e.g. "total_damage"
    direction: Literal["max", "min"]
    # Same meaning as a prize's scope. "peak" is for the fields that are a best
    # single moment already: summing each game's biggest attack across the night
    # ranks nothing anyone asked for.
    scope: Literal["night", "peak"] = "night"


@dataclass(frozen=True)
class Prize:
    key: str
    name: str
    metric: str                   # a stat field, or "win_points"
    agg: Literal["max", "min"]
    scope: Literal["night", "peak"]
    tiebreak: Tiebreak | None = None


@dataclass(frozen=True)
class ScoringConfig:
    placement_points: dict[int, int]
    total_damage_fields: list[str]
    prizes: list[Prize]
    # Players who play and score but take no prize: each prize goes to the
    # next in line instead. For the organiser who is also at a table.
    prize_ineligible: tuple[str, ...] = ()

    @staticmethod
    def from_dict(cfg: dict) -> ScoringConfig:
        scoring = cfg["scoring"]
        prizes = [
            Prize(
                key=p["key"],
                name=p["name"],
                metric=p["metric"],
                agg=p["agg"],
                scope=p["scope"],
                tiebreak=(
                    Tiebreak(
                        p["tiebreak"]["field"],
                        p["tiebreak"]["direction"],
                        p["tiebreak"].get("scope", "night"),
                    )
                    if p.get("tiebreak")
                    else None
                ),
            )
            for p in cfg["prizes"]
        ]
        # A lone name is easy to write without the brackets, and iterating the
        # bare string would exclude the letters J, e, s instead of Jesse.
        ineligible = scoring.get("prize_ineligible") or ()
        if isinstance(ineligible, str):
            ineligible = (ineligible,)
        return ScoringConfig(
            placement_points={int(k): int(v) for k, v in scoring["placement_points"].items()},
            total_damage_fields=list(scoring["total_damage_fields"]),
            prizes=prizes,
            prize_ineligible=tuple(str(n) for n in ineligible),
        )


# --- Outputs ----------------------------------------------------------------

@dataclass
class PlayerStanding:
    player: str
    win_points: int = 0
    total_damage: int = 0
    games_played: int = 0
    # summed stat fields across the player's games
    totals: dict[str, int] = field(default_factory=dict)
    # the player's single best (max) value per field across games
    peaks: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class PrizeResult:
    key: str
    name: str
    winner: str | None
    value: int | None


_SUMMABLE = (
    "combat_dmg_dealt",
    "noncombat_dmg_dealt",
    "cmdr_dmg_dealt",
    "opps_eliminated",
    "biggest_attack_dealt",
    "biggest_attack_taken",
    "most_creatures_in_attack",
    "total_graveyard",
    "combat_dmg_taken",
    "creatures_attacked_with",
)


def build_standings(
    stats: Iterable[GamePlayerStat],
    config: ScoringConfig,
    roster: list[str],
) -> list[PlayerStanding]:
    """One standing per rostered player, in roster order (roster order is the
    deterministic tiebreaker for prizes with no explicit tiebreak)."""
    standings = {name: PlayerStanding(player=name) for name in roster}

    for s in stats:
        if s.player not in standings:
            # ignore stray records not on the roster
            continue
        if not s.played:
            # Seated, nothing recorded. Counting it would make the player a
            # contender on zeros, and zero wins every `min` prize.
            continue
        st = standings[s.player]
        st.games_played += 1
        st.win_points += config.placement_points.get(s.placement, 0)
        st.total_damage += sum(getattr(s, f) for f in config.total_damage_fields)
        for f in _SUMMABLE:
            v = getattr(s, f)
            st.totals[f] = st.totals.get(f, 0) + v
            st.peaks[f] = max(st.peaks.get(f, 0), v)

    return [standings[name] for name in roster]


def _metric_value(st: PlayerStanding, prize: Prize) -> int:
    if prize.metric == "win_points":
        return st.win_points
    if prize.scope == "peak":
        return st.peaks.get(prize.metric, 0)
    return st.totals.get(prize.metric, 0)


def _tiebreak_value(st: PlayerStanding, tb: Tiebreak) -> int:
    if tb.field == "total_damage":
        return st.total_damage
    if tb.field == "win_points":
        return st.win_points
    if tb.scope == "peak":
        return st.peaks.get(tb.field, 0)
    return st.totals.get(tb.field, 0)


def resolve_prize(
    prize: Prize, standings: list[PlayerStanding], *, ineligible: Collection[str]
) -> PrizeResult:
    """The prize's winner, or None when nobody has earned it yet.

    "Nobody has earned it" is asymmetric between the two aggregations, and the
    asymmetry is the point:

    * A `max` prize rewards doing the most of something. A winning value of zero
      means the whole field did none of it, so there is no winner — awarding it
      anyway hands the prize to whoever sorts first, which after round one is
      simply the first name on the roster. That is the difference between "Alice
      milled the most" and "nobody milled, and Alice is called Alice".
    * A `min` prize rewards doing the least, so zero is the best possible score
      and a genuine win. "40 Is More Than 21" is *meant* to go to the player who
      dealt no commander damage at all. That is only safe because a contender
      has to have played (see GamePlayerStat.played): a player who has merely
      been seated is not one.

    Callers render a None winner as unclaimed; see display/_board.html.

    `ineligible` players are not contenders at all, so a prize they would have
    won goes to the runner-up, and the unclaimed rule above then applies to
    that runner-up's value. Required rather than defaulted: a page that forgot
    to pass it would award an excluded player without a word.
    """
    contenders = [s for s in standings if s.games_played > 0 and s.player not in ineligible]
    if not contenders:
        return PrizeResult(prize.key, prize.name, None, None)

    def sort_key(st: PlayerStanding):
        primary = _metric_value(st, prize)
        # For max we want the largest first; for min the smallest first.
        # Encode both so we can always pick the first element after sorting.
        primary_key = -primary if prize.agg == "max" else primary
        if prize.tiebreak:
            tb = _tiebreak_value(st, prize.tiebreak)
            tb_key = -tb if prize.tiebreak.direction == "max" else tb
        else:
            tb_key = 0  # roster order (stable sort) breaks remaining ties
        return (primary_key, tb_key)

    winner = sorted(contenders, key=sort_key)[0]  # stable → roster order on full ties
    value = _metric_value(winner, prize)
    if prize.agg == "max" and value <= 0:
        return PrizeResult(prize.key, prize.name, None, None)
    return PrizeResult(prize.key, prize.name, winner.player, value)


def ranked_standings(standings: list[PlayerStanding]) -> list[tuple[int, PlayerStanding]]:
    """Standings in board order, each paired with its competition rank.

    Ties share a rank and consume the places below them (1, 2, 2, 4). Two
    players level on both win points and the damage tiebreaker are not first and
    second — they are joint first, and numbering them 1 and 2 puts one of them
    above the other on the projector on no authority but sort order.

    Players who have not played yet are all level on zero, so they share the
    last rank between them.
    """
    ordered = sorted(standings, key=lambda s: (-s.win_points, -s.total_damage))
    ranked: list[tuple[int, PlayerStanding]] = []
    for i, st in enumerate(ordered):
        tied = i > 0 and (st.win_points, st.total_damage) == (
            ordered[i - 1].win_points,
            ordered[i - 1].total_damage,
        )
        ranked.append((ranked[-1][0] if tied else i + 1, st))
    return ranked


def leaderboard(
    stats: Iterable[GamePlayerStat],
    config: ScoringConfig,
    roster: list[str],
) -> list[PrizeResult]:
    standings = build_standings(stats, config, roster)
    return [
        resolve_prize(p, standings, ineligible=config.prize_ineligible) for p in config.prizes
    ]
