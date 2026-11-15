"""Form models for tracker data entry, plus the domain records storage returns.

Two forms now, because the tracking sheet has two:

  TurnEntry   one turn cycle -- saved many times per match, mid-game
  FinalEntry  the "Entered at Player Death or Win" section -- saved once

TURN_FIELDS and GAME_STAT_FIELDS are the declarative descriptions the routes
validate against and the templates render from, so adding a stat means editing a
list (plus schema.sql and the prize in config), not rewriting a form.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from pydantic import BaseModel, Field, field_validator


@dataclass(frozen=True)
class Player:
    """One `players` row. `commander` is optional free text."""

    player_id: int
    name: str
    commander: str | None


@dataclass(frozen=True)
class Game:
    """One `games` row. A game is a pod playing one match of the night.

    `match_no` is the tracking sheet's "Match #" (1..games_per_player). It was
    called `round` until the sheet made the collision obvious -- a "round" there
    is a turn cycle *inside* a match, which is what TurnStat.round_no counts.
    """

    game_id: int
    pod: str
    match_no: int


@dataclass(frozen=True)
class TurnStat:
    """One player's one turn cycle -- one row of the sheet's Stat Tracker.

    `damage` maps an opponent's name to the combat damage dealt to them this
    turn (the sheet's per-player columns, restricted to the seated opponents).
    Absent opponents mean zero; nobody has to type a zero to say "I did not
    attack them".
    """

    round_no: int
    attacking_creatures: int = 0
    cmdr_dmg_dealt: int = 0
    noncombat_dmg_dealt: int = 0
    opps_eliminated: int = 0
    damage: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class RecordedTurn:
    """One stored turn, carrying the game it belongs to.

    `turn_grid` answers "what has this table entered"; this answers "what did
    the whole night look like", which is what the turn-level export walks.
    """

    game_id: int
    player: str
    turn: TurnStat


@dataclass(frozen=True)
class FinalStat:
    """The sheet's "Entered at Player Death or Win" section.

    `placement` is None while the player is still alive, which is the whole
    point of splitting this off from the turn rows: a tracker can save turns all
    game without being asked to predict the finishing order.
    """

    placement: int | None = None
    final_life: int = 0
    total_graveyard: int = 0


@dataclass(frozen=True)
class StatField:
    name: str
    label: str
    hint: str
    # Column heading for dense tables. The results sheet puts every stat beside
    # placement, player and life, and eleven columns of "Most creatures
    # attacking" do not fit across a sheet of A4 — so the sheet abbreviates and
    # prints a legend. The forms keep the full label.
    short: str = ""


# The numeric inputs on one turn row, in the order the sheet asks for them: the
# damage grid sits between attacking_creatures and cmdr_dmg_dealt and is built
# per-table from the seating, so it is not in this list.
TURN_FIELDS: tuple[StatField, ...] = (
    StatField("attacking_creatures", "Attacking creatures", "Declared this combat", "Creatures"),
    StatField("cmdr_dmg_dealt", "Commander damage", "Already counted in the grid above", "Cmdr"),
    StatField("noncombat_dmg_dealt", "Non-combat damage", "Burn, pingers, drains. Not the tiebreaker", "Non-cbt"),
    StatField("opps_eliminated", "Opponents eliminated", "Kills credited this turn", "Elims"),
)

# What a finished game looks like once the turns are aggregated. These are
# GamePlayerStat attribute names: the results sheet, the pod table and the
# public board all render from this list, and none of them is entered by hand
# any more — every one is derived (see _DERIVED_STATS in app/repository.py).
GAME_STAT_FIELDS: tuple[StatField, ...] = (
    StatField("combat_dmg_dealt", "Combat damage dealt", "Summed over the damage grid", "Combat"),
    StatField("noncombat_dmg_dealt", "Non-combat damage dealt", "Summed over turns", "Non-cbt"),
    StatField("cmdr_dmg_dealt", "Commander damage dealt", "Summed over turns", "Cmdr"),
    StatField("opps_eliminated", "Opponents eliminated", "Summed over turns", "Elims"),
    StatField("biggest_attack_dealt", "Biggest attack dealt", "Best single turn's combat damage", "Big hit"),
    StatField("biggest_attack_taken", "Biggest attack taken", "Most taken from one attacker in a turn", "Big taken"),
    StatField("most_creatures_in_attack", "Most creatures attacking", "Best single turn", "Creatures"),
    StatField("total_graveyard", "Cards in graveyard", "Counted at death or win", "Yard"),
)

# Longest commander a player may be given, on the roster or for a single match.
# Mirrored by maxlength= on the inputs and enforced in both routes that accept
# one: maxlength is a client-side hint, and an unbounded deck name reaches the
# projected display and the results sheet.
COMMANDER_MAX = 80

# Upper bound on every numeric stat a tracker can enter. Event owner's number,
# raised from 9999 to 99999 on 2026-11-14: Commander has combos that deal damage
# in a loop, and a cap a real game can reach is a cap that throws away the game
# it was reached in. Still small enough that a hand resting on a keypad is
# rejected at the field rather than reaching storage — where an over-wide value
# used to raise OverflowError inside the write and drop the tracker's row with no
# visible error at all (KG-10).
STAT_MAX = 99999

# A match cannot run forever, and an unbounded round_no would let a stuck client
# hammer in rows that no table ever played.
MAX_ROUNDS = 99


def _blank_to_zero(v: object) -> object:
    if isinstance(v, str) and v.strip() == "":
        return 0
    return v


class TurnEntry(BaseModel):
    """One submitted turn form = one turn_stats row plus its damage grid.

    The per-opponent damage is NOT a field here: the opponents differ per table
    and per match, so the route reads them off the seating and validates them
    with `clean_damage()` below. Everything that is the same at every table
    stays declared, and gets pydantic's bounds for free.
    """

    pod: str = Field(min_length=1)
    # Capped so an absurd value fails validation here rather than overflowing
    # SQLite in find_game; the route checks it against games_per_player.
    match_no: int = Field(ge=1, le=MAX_ROUNDS)
    player: str = Field(min_length=1)
    round_no: int = Field(ge=1, le=MAX_ROUNDS)

    attacking_creatures: int = Field(default=0, ge=0, le=STAT_MAX)
    cmdr_dmg_dealt: int = Field(default=0, ge=0, le=STAT_MAX)
    noncombat_dmg_dealt: int = Field(default=0, ge=0, le=STAT_MAX)
    opps_eliminated: int = Field(default=0, ge=0, le=STAT_MAX)

    @field_validator(*[f.name for f in TURN_FIELDS], mode="before")
    @classmethod
    def _blank_is_zero(cls, v: object) -> object:
        """A tracker who leaves a box empty means zero — which is most boxes on
        most turns, and typing a zero forty times a game is how trackers stop
        entering turns at all."""
        return _blank_to_zero(v)

    def to_turn(self, damage: dict[str, int]) -> TurnStat:
        return TurnStat(
            round_no=self.round_no,
            damage=damage,
            **{f.name: getattr(self, f.name) for f in TURN_FIELDS},
        )


class FinalEntry(BaseModel):
    """The death/win form = one game_player_stats row.

    `placement` is optional, unlike everything else here. It used to be required
    on every save, which made it impossible to record a turn before the game had
    finished — the form demanded the finishing order from a tracker watching
    turn three. Now a blank placement means "still playing", and scoring reads
    it through placement_points.get() so an unfinished row scores zero.
    """

    pod: str = Field(min_length=1)
    match_no: int = Field(ge=1, le=MAX_ROUNDS)
    player: str = Field(min_length=1)
    placement: int | None = Field(default=None, ge=1)
    # Signed: life goes negative on a lethal hit. Bounded both ways.
    final_life: int = Field(default=0, ge=-STAT_MAX, le=STAT_MAX)
    total_graveyard: int = Field(default=0, ge=0, le=STAT_MAX)

    @field_validator("final_life", "total_graveyard", mode="before")
    @classmethod
    def _blank_is_zero(cls, v: object) -> object:
        return _blank_to_zero(v)

    @field_validator("placement", mode="before")
    @classmethod
    def _blank_is_unfinished(cls, v: object) -> object:
        """Blank is None, not zero: "no placement yet" is a real state now, and
        zero is not a placement anybody can finish in."""
        if isinstance(v, str) and v.strip() == "":
            return None
        return v

    def to_final(self) -> FinalStat:
        return FinalStat(
            placement=self.placement,
            final_life=self.final_life,
            total_graveyard=self.total_graveyard,
        )


class DamageError(ValueError):
    """A damage-grid cell that will not do. Carries the field name so the route
    can put the message under the right input rather than at the top of the
    form, where a tracker on a phone has to scroll to find out which of three
    identical-looking boxes it means."""

    def __init__(self, field: str, message: str):
        super().__init__(message)
        self.field = field
        self.message = message


def clean_damage(submitted: dict[str, str], opponents: list[str]) -> dict[str, int]:
    """Pull the damage grid out of a submitted form.

    Inputs are named by SEAT (`dmg_2`), not by player name: names come from a
    user-editable roster and can hold spaces, quotes and non-ASCII, none of
    which survive a round trip through an HTML attribute cleanly.

    `opponents` is the seating minus the player themselves, so a cell can only
    ever address somebody actually at the table.
    """
    damage: dict[str, int] = {}
    for i, name in enumerate(opponents, start=1):
        raw = str(submitted.get(f"dmg_{i}", "")).strip()
        if raw == "":
            continue
        try:
            value = int(raw)
        except ValueError:
            raise DamageError(f"dmg_{i}", "whole numbers only") from None
        if not 0 <= value <= STAT_MAX:
            raise DamageError(f"dmg_{i}", f"must be between 0 and {STAT_MAX}")
        damage[name] = value
    return damage
