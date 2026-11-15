"""Tracker data-entry surface.

One screen per (pod, match). The table is seated first -- seating rotates every
match, so it is data, not an inference -- and from then on the screen has two
jobs, matching the two halves of the event owner's tracking sheet:

  POST /entry/turn    one player's one turn cycle, saved live during play
  POST /entry/final   the "Entered at Player Death or Win" section, saved once
  POST /entry/eliminations  the same section for everybody a turn put out

Splitting them is what lets a turn be recorded before anyone knows the finishing
order. The old single form demanded a placement on every save, so a tracker
three turns into a game could not save at all.

Endpoints:
  GET  /entry         full page
  GET  /entry/form    HTMX partial: the panel for the current selection
  POST /entry/seat    set who is at this table, in turn order
  POST /entry/commanders  which deck each seated player brought to this match
  POST /entry/turn    save a turn cycle, then re-render panel + pod table
  POST /entry/turn/draft    keep what is typed so far, without moving anything
  POST /entry/final   save the death/win section, same re-render
  POST /entry/eliminations  save a death/win row per player a turn put out

A turn that eliminates somebody is the one moment the two halves of the sheet
meet: the killer's row says how many went out, and each dead player's own
section says who they were and how they finished. Entered through /entry/final
that meant leaving the turn, selecting the dead player, filling their section,
and doing it again for the second one -- mid-game, on a phone, with the table
waiting. /entry/eliminations offers one row per death instead, and derives the
placements from the order of the rows (see _finishing_order).

The decks are their own form, not boxes on the seating form, because a deck
belongs to a player rather than to a seat (see match_commanders in schema.sql).
On the seating form the boxes would have had to be paired with the selects by
position, so changing seat 3's player would leave the previous occupant's deck
sitting in the box next to the new one -- and the submit would silently record
it against them. Here every box is labelled with the name it writes to.
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from pydantic import ValidationError

from app.config import EventConfig, load_event, load_scoring
from app.events import broadcaster
from app.models import (
    COMMANDER_MAX,
    GAME_STAT_FIELDS,
    MAX_ROUNDS,
    TURN_FIELDS,
    DamageError,
    FinalEntry,
    FinalStat,
    TurnEntry,
    clean_damage,
)
from app.repository import Storage
from app.routes import StorageDep, templates

router = APIRouter(prefix="/entry", tags=["entry"])

_ORDINAL_SUFFIXES = {1: "st", 2: "nd", 3: "rd"}

# pydantic's own messages are written for developers. A tracker on a phone got
# "Input should be a valid integer, unable to parse string as an integer" when
# they left a box empty, which says nothing about which box or what to do.
_FRIENDLY = {
    "int_parsing": "whole numbers only",
    "int_type": "whole numbers only",
    "missing": "required",
    "string_too_short": "required",
}


def _ordinal(n: int) -> str:
    """1 -> 1st, 2 -> 2nd, 11 -> 11th, 21 -> 21st.

    Placements come from `placement_points`, which is config, so this cannot
    assume the 1..4 of a Commander pod — a table of 21 would have been "21th".
    """
    suffix = "th" if n % 100 in (11, 12, 13) else _ORDINAL_SUFFIXES.get(n % 10, "th")
    return f"{n}{suffix}"


def _placement_label(place: int, points: int) -> str:
    return f"{_ordinal(place)} — {points} pt{'' if points == 1 else 's'}"


# Out-of-range values, worded the way the damage grid already words them
# rather than as "Input should be less than or equal to 99999".
_BOUNDS = {"less_than_equal": ("le", "at most {}"), "greater_than_equal": ("ge", "at least {}")}


def _errors_from(exc: ValidationError) -> dict[str, str]:
    """Map a ValidationError onto {field: message} in the tracker's language."""
    out: dict[str, str] = {}
    for err in exc.errors():
        field = str(err["loc"][0]) if err["loc"] else "form"
        kind = str(err["type"])
        if kind in _BOUNDS:
            key, template = _BOUNDS[kind]
            message = template.format(err.get("ctx", {}).get(key, ""))
        else:
            message = _FRIENDLY.get(kind, err["msg"])
        out.setdefault(field, message)
    return out


def _event_id(request: Request) -> int:
    return request.app.state.event_id


def _expected_pod_size(event: EventConfig, placements: list[int]) -> int:
    """How many players sit at one table.

    Defaults to the number of placement tiers, because those are the finishing
    positions at a table: `placement_points` runs 1..4 exactly because a pod
    seats four, and you cannot come fourth at a table of three. `event.pod_size`
    states it outright for events whose pods do not seat one player per
    placement (a house rule that ranks only the top two, say).
    """
    return event.pod_size or len(placements)


def _next_up(
    seating: list[str], out: set[str], entered: set[tuple[str, int]], played: int
) -> tuple[str | None, int]:
    """Who a tracker opening this table most likely wants: the first player
    still in the game who has not entered the round in progress, or, once all
    of them have, the first of them in the next round.

    This is what a reload lands on. It used to be seat 1 in the latest round,
    which after seat 1 had already played meant a tracker reopening the page
    was shown a turn that was already saved, under a badge small enough to miss.
    """
    active = [n for n in seating if n not in out] or seating
    if not active:
        return None, 1
    current = max(played, 1)
    for name in active:
        if (name, current) not in entered:
            return name, current
    return active[0], min(current + 1, MAX_ROUNDS)


def _seat_after(
    seating: list[str], out: set[str], player: str, round_no: int
) -> tuple[str, int]:
    """The seat that plays after `player`, skipping anyone already out.
    Passing the last seat starts the next round. A player knocked out keeps
    their seat (their turns still count), but nobody takes turns for them, and
    landing on them every lap made the tracker reselect by hand."""
    i = seating.index(player)
    for step in range(1, len(seating) + 1):
        j = (i + step) % len(seating)
        if seating[j] not in out or step == len(seating):
            return seating[j], min(round_no + 1 if j <= i else round_no, MAX_ROUNDS)
    raise AssertionError("unreachable: the loop returns on its last step")


def _out(pod_stats: list) -> dict[str, int]:
    """Players with a placement, which is how a tracker records that they are
    out (or won). Maps name to placement."""
    return {s.player: s.placement for s in pod_stats if s.placement is not None}


def _deck_prefill(
    storage: Storage, event_id: int, match_no: int, seating: list[str]
) -> dict[str, str]:
    """{seated player: deck to show in their box} for this match.

    Recorded value first, then the roster default. Keyed by name and built only
    for the players at this table, so the form cannot post a deck for somebody
    sitting at the other pod.
    """
    if not seating:
        return {}
    recorded = storage.commanders_for_match(event_id, match_no)
    usual = {p.name: p.commander for p in storage.players(event_id) if p.commander}
    return {name: recorded.get(name) or usual.get(name, "") for name in seating}


def _elimination_prompt(
    seating: list[str],
    out: dict[str, int],
    turn_grid: dict[tuple[str, int], Any],
    placement_points: dict[int, int],
    just_credited: int = 0,
) -> dict[str, Any]:
    """The rows to offer for deaths that have been credited but not recorded.

    A turn form says how many opponents a player eliminated; the dead players'
    own sections say who they were and in what order they went. Those are two
    different forms, so the count is the only thing that knows a death is
    outstanding: eliminations credited on the turns, minus the players already
    recorded out.

    Derived on every render rather than set by the save that triggered it, so a
    reload does not lose the prompt, a second tracker opening the table sees it
    too, and recording the deaths is what makes it go away. A death nobody was
    credited for -- a concede, a deck-out, a game called on time -- never raises
    the count, and is still recorded on the player's own form.
    """
    best = min(placement_points) if placement_points else 1
    still_in = [n for n in seating if n not in out]
    credited = sum(t.opps_eliminated for t in turn_grid.values())
    # The winner holds a placement without having gone out, so they are not a
    # recorded death. Counting them as one would hide the last elimination of
    # every game -- the one that ends it.
    recorded = sum(1 for place in out.values() if place != best)
    due = max(0, min(credited - recorded, len(still_in)))

    # A death nobody was credited for -- a suicide, a concede, a deck-out --
    # makes that difference smaller, and can cancel a kill that IS outstanding:
    # credit one elimination, record one suicide, and the count nets to nothing
    # with a death still unrecorded. Counts alone cannot tell those apart, so
    # the turn that credits the kill raises the rows itself (`just_credited`),
    # and the derived count only has to keep them there afterwards. A reload in
    # that state still loses the prompt, and the player's own form is the
    # fallback it always was.
    if just_credited > 0:
        due = max(due, min(just_credited, len(still_in)))

    def label(place: int) -> str:
        points = placement_points.get(place)
        return _placement_label(place, points) if points is not None else _ordinal(place)

    return {
        "deaths_due": due,
        # Worst placement first: the first player out of a table of four
        # finishes 4th, so the order of the rows IS the order of elimination.
        "elimination_rows": [
            {
                "place": len(still_in) - i,
                "label": label(len(still_in) - i),
                # The row is headed by its place in the order, because that is
                # what the tracker is being asked for; the placement it earns
                # is shown underneath as the consequence.
                "order": _ordinal(i + 1),
            }
            for i in range(due)
        ],
        "elimination_candidates": still_in,
        # When these deaths would leave one player standing, that player has
        # won, and their own three numbers are the ones a tracker has to come
        # back for after the table has broken up. Offered in the same form.
        "winner_row": (
            {"place": best, "label": label(best)}
            if due and len(still_in) - due == 1
            else None
        ),
    }


def _finishing_order(
    rows: list[tuple[str, int]], still_in: int, simultaneous: bool
) -> dict[str, int]:
    """Placement per player going out, from the order they went out in.

    `rows` is (player, life at death) in the order the tracker listed them,
    first out first, and `still_in` is how many were playing before any of it:
    the first player out of a table of four finishes 4th, so the placements run
    down from there. Asking for the order and deriving the number is fewer taps
    than a placement select per row, and it cannot produce two players claiming
    the same place by accident.

    `simultaneous` is one attack killing several at once, where there is no
    order of elimination to list. The event owner's rule ranks those by life at
    death, least negative higher, so the lowest life went out first and takes
    the worst placement.

    Identical totals are a genuine tie, and a tie takes the BEST placement of
    the block it occupies, leaving the rest unused: two players tied over 3rd
    and 4th both finish 3rd and nobody finishes 4th. That is how a tie is
    ranked anywhere else, and it is what "tied players each receive the full
    placement score" asks for in docs/DATA_MODEL.md -- the alternative docks
    both of them a place for having died at the same moment.
    """
    ordered = sorted(rows, key=lambda r: r[1]) if simultaneous else list(rows)
    places: dict[str, int] = {}
    i = 0
    while i < len(ordered):
        # The list is sorted, so everybody on this life total is contiguous.
        block = (
            [r for r in ordered[i:] if r[1] == ordered[i][1]]
            if simultaneous
            else [ordered[i]]
        )
        place = still_in - i - (len(block) - 1)
        for player, _ in block:
            places[player] = place
        i += len(block)
    return places


def _elim_error_keys(row: int) -> dict[str, str]:
    """Which box an error belongs under. Nine numbered boxes in one form, so a
    message at the top of it says nothing about which one to look at."""
    return {"final_life": f"elim_life_{row}", "total_graveyard": f"elim_yard_{row}"}


def _resolve_selection(
    pod: str | None,
    match_no: int | None,
    pods: list[str],
    matches: list[int],
) -> tuple[str, int]:
    """Fall back to the first valid option rather than 404ing — the selectors are
    driven by the same lists, so an out-of-range value means a stale tab."""
    return (
        pod if pod in pods else pods[0],
        match_no if match_no in matches else matches[0],
    )


def _context(
    request: Request,
    storage: Storage,
    pod: str | None,
    match_no: int | None,
    player: str | None,
    round_no: int | None = None,
    *,
    values: dict[str, Any] | None = None,
    errors: dict[str, str] | None = None,
    elim: dict[str, Any] | None = None,
    just_credited: int = 0,
    saved: str = "",
) -> dict[str, Any]:
    event = load_event()
    scoring = load_scoring()
    event_id = _event_id(request)
    roster = storage.roster(event_id)
    matches = list(range(1, event.games_per_player + 1))

    pod, match_no = _resolve_selection(pod, match_no, event.pods, matches)
    placements = sorted(scoring.placement_points)
    pod_size = _expected_pod_size(event, placements)

    game_id = storage.find_game(event_id, pod, match_no)
    seating = storage.seating(game_id) if game_id is not None else []
    played = storage.rounds_played(game_id) if game_id is not None else 0
    turn_grid = storage.turn_grid(game_id) if game_id is not None else {}
    pod_stats = storage.stats_for_game(game_id) if game_id is not None else []
    out = _out(pod_stats)

    valid_round = round_no is not None and 1 <= round_no <= MAX_ROUNDS
    if player not in seating:
        # No player asked for (a fresh page, a pod or match switch), or one from
        # a stale tab who is not at this table: land on whoever is next up
        # rather than offer a form that is already saved or cannot be saved.
        player, next_round = _next_up(seating, set(out), set(turn_grid), played)
        if not valid_round:
            round_no = next_round
    elif not valid_round:
        # The table shares one round counter: default to the round in progress.
        round_no = max(played, 1)
    opponents = [n for n in seating if n != player]

    # The round control is a selector rather than a free number. It offers the
    # rounds this table has played plus the next one, which is every round a
    # tracker can legitimately be entering -- and it makes the one slip that is
    # now expensive impossible: typing 1 for 11 lands on a round finished an
    # hour ago, and since each box keeps itself as it is left, merely leaving a
    # box there overwrites it. A round carried in on the URL is offered even
    # when it is past the end, so a stale link cannot be quietly retargeted at
    # a round nobody asked for.
    offered = set(range(1, min(played + 1, MAX_ROUNDS) + 1))
    if round_no:
        offered.add(round_no)
    this_players_rounds = {r for n, r in turn_grid if n == player}
    round_options = [(r, r in this_players_rounds) for r in sorted(offered)]

    turn = storage.turn_for(game_id, player, round_no) if game_id and player else None
    final = storage.final_for(game_id, player) if game_id and player else None

    # The finishing order is the order players go out, so the place the next
    # one to go out takes is the count of players still in. A suggestion only:
    # simultaneous deaths and games on time are the tracker's call.
    still_in = len([n for n in seating if n not in out])
    suggested_placement = (
        still_in if player not in out and still_in in scoring.placement_points else None
    )

    if values is None:
        # Prefill from what is recorded, so a re-save corrects the row instead
        # of blanking the fields the tracker did not retype.
        values = {
            **{f.name: (getattr(turn, f.name) if turn else "") for f in TURN_FIELDS},
            **{
                f"dmg_{i}": (turn.damage.get(name, "") if turn else "")
                for i, name in enumerate(opponents, start=1)
            },
            "placement": (
                final.placement if final and final.placement else suggested_placement or ""
            ),
            "final_life": final.final_life if final else "",
            "total_graveyard": final.total_graveyard if final else "",
        }

    # Everyone already dealt into another pod for this match. Seating the same
    # player twice in one match would give them two rows for one game and
    # quietly double their win points.
    taken = storage.seated_elsewhere(event_id, match_no, game_id)

    # The deck boxes for this table: what is recorded for this match, falling
    # back to the player's usual deck from the roster. The fallback is only a
    # pre-fill -- until the form is saved, nothing is recorded for the match,
    # which is what keeps "they brought their usual" and "nobody said" distinct
    # on the results sheet.
    commanders = _deck_prefill(storage, event_id, match_no, seating)

    return {
        "request": request,
        "event": event,
        "pods": event.pods,
        "matches": matches,
        "roster": roster,
        "pod": pod,
        "match_no": match_no,
        "player": player,
        "round_no": round_no,
        "round_options": round_options,
        "rounds_played": played,
        "seating": seating,
        "opponents": opponents,
        "seatable": [n for n in roster if n not in taken],
        "commanders": commanders,
        "commander_max": COMMANDER_MAX,
        "placement_options": [
            (p, _placement_label(p, scoring.placement_points[p])) for p in placements
        ],
        "pod_size": pod_size,
        "turn_fields": TURN_FIELDS,
        "game_stat_fields": GAME_STAT_FIELDS,
        "values": values,
        "errors": errors or {},
        "turn": turn,
        "final": final,
        "turn_grid": turn_grid,
        "pod_stats": pod_stats,
        # For the player picker: who is out, and who has entered this round.
        "out": {name: _ordinal(place) for name, place in out.items()},
        "entered": {name for name, r in turn_grid if r == round_no},
        "final_open": any(k in (errors or {}) for k in _FINAL_FIELDS),
        # What the tracker typed into the elimination form, when it is coming
        # back refused. Nine boxes is too many to retype over one bad digit.
        "elim": elim,
        "saved": saved,
        **_elimination_prompt(
            seating, out, turn_grid, scoring.placement_points, just_credited
        ),
    }


# The death/win form's own inputs. Its section opens on its own only when one
# of these comes back with an error.
_FINAL_FIELDS = ("placement", "final_life", "total_graveyard")


def _panel(request: Request, ctx: dict[str, Any], status_code: int = 200) -> HTMLResponse:
    """Render the panel, and put where the tracker now is into the address bar.

    Every save moves the tracker (next seat, next round), but htmx swaps leave
    the URL alone, so a reload used to drop them back on pod A, match 1, seat 1.
    Replace rather than push: a game is a hundred saves, and Back should leave
    the page, not step through them.
    """
    response = templates.TemplateResponse(request, "entry/_panel.html", ctx, status_code=status_code)
    params: dict[str, Any] = {"pod": ctx["pod"], "match_no": ctx["match_no"]}
    if ctx["player"]:
        params |= {"player": ctx["player"], "round_no": ctx["round_no"]}
    response.headers["HX-Replace-Url"] = (
        f"{request.app.url_path_for('entry_index')}?{urlencode(params)}"
    )
    return response


@router.get("", response_class=HTMLResponse, name="entry_index")
def index(
    request: Request,
    storage: StorageDep,
    pod: str | None = None,
    match_no: int | None = None,
    player: str | None = None,
    round_no: int | None = None,
) -> HTMLResponse:
    ctx = _context(request, storage, pod, match_no, player, round_no)
    return templates.TemplateResponse(request, "entry/index.html", ctx)


@router.get("/form", response_class=HTMLResponse, name="entry_form")
def form(
    request: Request,
    storage: StorageDep,
    pod: str | None = None,
    match_no: int | None = None,
    player: str | None = None,
    round_no: int | None = None,
) -> HTMLResponse:
    ctx = _context(request, storage, pod, match_no, player, round_no)
    return _panel(request, ctx)


@router.post("/seat", response_class=HTMLResponse, name="entry_seat")
async def seat(request: Request, storage: StorageDep) -> HTMLResponse:
    """Set who is at this table, in turn order. Creates the game if needed."""
    form = await request.form()
    # getlist, not a dict: the seat inputs deliberately share one name, so the
    # browser sends `seat` once per seat and their order is the turn order.
    raw = form.getlist("seat")
    pod = str(form.get("pod", ""))
    match_no = _as_int(form.get("match_no"))

    event = load_event()
    scoring = load_scoring()
    event_id = _event_id(request)
    roster = storage.roster(event_id)
    matches = list(range(1, event.games_per_player + 1))
    pod_size = _expected_pod_size(event, sorted(scoring.placement_points))

    names = [str(n) for n in raw if str(n).strip()]
    errors: dict[str, str] = {}
    if pod not in event.pods:
        errors["pod"] = f"unknown pod {pod!r}"
    if match_no not in matches:
        errors["match_no"] = f"match must be 1–{event.games_per_player}"

    # Clearing frees this table's players for the other pod. Without it a swap
    # between pods deadlocks once all eight are dealt: each table refuses the
    # player the other one holds. Nothing recorded is deleted (seat_players).
    if form.get("clear") and not errors:
        game_id = storage.find_game(event_id, pod, match_no)
        if game_id is not None:
            storage.seat_players(game_id, [])
            await broadcaster.publish("stats-updated")
        ctx = _context(request, storage, pod, match_no, None, saved="Table cleared")
        return _panel(request, ctx)

    if len(names) != pod_size:
        errors["seating"] = f"a table seats {pod_size} — {len(names)} chosen"
    if len(set(names)) != len(names):
        errors["seating"] = "the same player twice"
    if any(n not in roster for n in names):
        errors["seating"] = "somebody here is not on the roster"

    if not errors:
        game_id = storage.get_or_create_game(event_id, pod, match_no)
        clash = storage.seated_elsewhere(event_id, match_no, game_id) & set(names)
        if clash:
            errors["seating"] = (
                f"already seated at another pod this match: {', '.join(sorted(clash))}"
            )
        else:
            storage.seat_players(game_id, names)
            await broadcaster.publish("stats-updated")
            ctx = _context(request, storage, pod, match_no, names[0], saved="Table set")
            return _panel(request, ctx)

    ctx = _context(request, storage, pod, match_no, None, errors=errors)
    return _panel(request, ctx, status_code=422)


@router.post("/commanders", response_class=HTMLResponse, name="entry_commanders")
async def save_commanders(request: Request, storage: StorageDep) -> HTMLResponse:
    """Record which deck each player at this table brought to this match.

    Paired lists, not `commander_<name>` keys: a name can contain anything a
    roster allows, and building form keys out of it would need escaping that the
    template and the parser would have to agree on forever. The browser sends
    both lists in document order, so `player[i]` names the player `commander[i]`
    belongs to -- and unlike the seating form's selects, neither list has
    optional entries that could shift the pairing.

    Only players actually seated here are written. A stale tab naming somebody
    who has since moved to the other pod would otherwise record a deck against
    them from a table they are not at.
    """
    form = await request.form()
    names = [str(n) for n in form.getlist("player")]
    decks = [str(c) for c in form.getlist("commander")]
    pod = str(form.get("pod", ""))
    match_no = _as_int(form.get("match_no"))

    event = load_event()
    event_id = _event_id(request)
    matches = list(range(1, event.games_per_player + 1))

    errors: dict[str, str] = {}
    if pod not in event.pods:
        errors["pod"] = f"unknown pod {pod!r}"
    if match_no not in matches:
        errors["match_no"] = f"match must be 1–{event.games_per_player}"
    if len(names) != len(decks):
        # Only reachable from a hand-built POST; a browser sends one of each per
        # row. Refused rather than zipped short, because zip() would silently
        # drop the tail and report success for decks it never saved.
        errors["commanders"] = "the form was sent incomplete: open the table again"

    game_id = None if errors else storage.find_game(event_id, pod, match_no)
    seating = storage.seating(game_id) if game_id is not None else []
    # strict=False is safe here: unequal lists are already an error above, and
    # this dict is not read on that path.
    submitted = {n: c for n, c in zip(names, decks, strict=False) if n in seating}

    if not errors and any(len(c.strip()) > COMMANDER_MAX for c in submitted.values()):
        # maxlength= on the input is a client-side hint; an unbounded deck name
        # reaches the results sheet. Same bound as the roster's (models.py).
        errors["commanders"] = f"a commander must be {COMMANDER_MAX} characters or fewer"

    if errors:
        ctx = _context(request, storage, pod, match_no, None, errors=errors)
        return _panel(request, ctx, status_code=422)

    if not submitted:
        # Nobody named is at this table: a stale tab, or a table cleared since
        # the form was drawn. Re-render it rather than report a save that did
        # not happen -- the banner is the only proof the tracker gets.
        return _panel(request, _context(request, storage, pod, match_no, None))

    storage.set_match_commanders(event_id, match_no, submitted)
    # The results sheet renders the decks, so the display has to know. No
    # standing changes, but "stats-updated" is the one channel the sheet listens
    # on and a second event type would be a channel nothing reads.
    await broadcaster.publish("stats-updated")

    ctx = _context(request, storage, pod, match_no, None, saved="Commanders saved")
    return _panel(request, ctx)


class _StaleTable(Exception):
    """The damage boxes were drawn for a different set of opponents than are
    sitting here now. Every number in them means the wrong player, so the form
    goes back redrawn and empty rather than saved."""


_STALE_TABLE_MESSAGE = "the table changed since this form opened: enter the turn again"


def _validate_turn(
    request: Request,
    storage: Storage,
    submitted: dict[str, str],
    *,
    cross_checks: bool,
) -> tuple[TurnEntry | None, int | None, dict[str, int], dict[str, str]]:
    """Parse a submitted turn form: the entry, its game, its damage grid, and
    whatever is wrong with it.

    `cross_checks` are the two rules that read one box against another --
    commander damage has to be inside the damage grid already, and nobody can
    eliminate more opponents than are at the table. Both are true of a finished
    turn, which is what the Save button saves, so it asks for them.

    The autosave does not. A turn halfway through being typed breaks them
    innocently -- the commander damage box filled in before the grid it belongs
    in -- and refusing to keep those numbers is the very thing the autosave was
    added to stop. It asks only for the per-box bounds, which no correct entry
    ever breaks. The Save button stays the gate the finished row goes through.
    """
    errors: dict[str, str] = {}
    entry: TurnEntry | None = None
    try:
        entry = TurnEntry.model_validate(submitted)
    except ValidationError as exc:
        errors = _errors_from(exc)

    event = load_event()
    event_id = _event_id(request)
    matches = list(range(1, event.games_per_player + 1))

    game_id: int | None = None
    opponents: list[str] = []
    if entry is not None:
        if entry.pod not in event.pods:
            errors["pod"] = f"unknown pod {entry.pod!r}"
        if entry.match_no not in matches:
            errors["match_no"] = f"match must be 1–{event.games_per_player}"
        game_id = storage.find_game(event_id, entry.pod, entry.match_no)
        seating = storage.seating(game_id) if game_id is not None else []
        if entry.player not in seating:
            errors["player"] = f"{entry.player!r} is not at this table"
        else:
            opponents = [n for n in seating if n != entry.player]

        # Damage boxes are numbered by seat. A form drawn before a reseat would
        # put each number on whoever sits in that seat now. A form with no
        # `table` field predates the check and is let through.
        drawn_for = submitted.get("table")
        if opponents and drawn_for is not None and drawn_for != "|".join(opponents):
            raise _StaleTable

    damage: dict[str, int] = {}
    if entry is not None and not errors:
        try:
            damage = clean_damage(submitted, opponents)
        except DamageError as exc:
            errors[exc.field] = exc.message
        else:
            # Commander damage is combat damage, so it is already inside the
            # grid. Typed only into its own box, it would leave combat damage
            # (and every prize and tiebreak built on it) short.
            if cross_checks and entry.cmdr_dmg_dealt > sum(damage.values()):
                errors["cmdr_dmg_dealt"] = (
                    "more than the combat damage above: add it to the grid too"
                )
            if cross_checks and entry.opps_eliminated > len(opponents):
                errors["opps_eliminated"] = f"only {len(opponents)} opponents at this table"

    return entry, game_id, damage, errors


def _draft_status(request: Request, message: str, *, bad: bool = False) -> HTMLResponse:
    """The autosave's whole reply: one line, swapped into the turn form out of
    band so nothing else on the panel moves under the tracker's thumb.

    Always 200, even when it could not keep the numbers. htmx processes an
    out-of-band swap only from a response it would swap at all, and this app
    lets 422 through for exactly that reason (see base.html) -- but a 4xx here
    would also trip the "Not saved" banner meant for a lost connection, on a
    form the tracker is still halfway through typing.
    """
    return templates.TemplateResponse(
        request,
        "entry/_draft_status.html",
        {"request": request, "oob": True, "draft_status": message, "draft_bad": bad},
    )


@router.post("/turn", response_class=HTMLResponse, name="entry_turn")
async def save_turn(request: Request, storage: StorageDep) -> HTMLResponse:
    """Save one player's one turn cycle, damage grid included."""
    submitted = {k: str(v) for k, v in (await request.form()).items()}

    try:
        entry, game_id, damage, errors = _validate_turn(
            request, storage, submitted, cross_checks=True
        )
    except _StaleTable:
        # Redrawn without the stale numbers, rather than saved against whoever
        # sits in those seats now.
        ctx = _context(
            request, storage, submitted.get("pod"), _as_int(submitted.get("match_no")),
            submitted.get("player"), _as_int(submitted.get("round_no")),
            errors={"player": _STALE_TABLE_MESSAGE},
        )
        return _panel(request, ctx, status_code=422)

    if entry is None or errors:
        ctx = _context(
            request,
            storage,
            submitted.get("pod"),
            _as_int(submitted.get("match_no")),
            submitted.get("player"),
            _as_int(submitted.get("round_no")),
            values=submitted,
            errors=errors,
        )
        return _panel(request, ctx, status_code=422)

    assert game_id is not None
    storage.save_turn(game_id, entry.player, entry.to_turn(damage))

    # The display subscribes to this and pushes the recomputed leaderboard.
    # Payload is deliberately just a signal — the display re-renders from
    # storage rather than trusting a diff.
    await broadcaster.publish("stats-updated")

    # Advance to the next seat still in the game, so a tracker walking the
    # table taps Save and lands on whoever plays next instead of reselecting.
    seating = storage.seating(game_id)
    out = set(_out(storage.stats_for_game(game_id)))
    nxt, round_no = _seat_after(seating, out, entry.player, entry.round_no)

    ctx = _context(
        request, storage, entry.pod, entry.match_no, nxt, round_no,
        # Guarantees the rows at the moment the kill is entered, whatever the
        # derived count makes of it afterwards (_elimination_prompt).
        just_credited=entry.opps_eliminated,
        saved=f"Round {entry.round_no} saved for {entry.player}",
    )
    return _panel(request, ctx)


@router.post("/turn/draft", response_class=HTMLResponse, name="entry_turn_draft")
async def save_turn_draft(request: Request, storage: StorageDep) -> HTMLResponse:
    """Keep what has been typed into the turn form, without moving anything.

    Every numeric box in the turn form posts here as it is left, so a tracker
    four boxes into a turn who has to jump to another player -- to record the
    death that player's attack just caused -- comes back to find those four
    numbers still in it. Before this, switching player re-rendered the panel
    from storage and everything unsaved went with it.

    It writes the same turn_stats row the Save button writes, through the same
    upsert, so Save then rewrites it rather than adding a second one. And it
    deliberately does nothing else: no advance to the next seat, no banner, no
    panel swap. A redraw mid-entry moves the box being typed in, which is its
    own way of losing what is in it.

    It does not broadcast either. The display would otherwise push half-typed
    numbers to the projector a box at a time; the Save button that finishes the
    turn is a second away and broadcasts then.

    Replies with one status line. A silent autosave that quietly failed would be
    worse than none at all -- the tracker would switch player believing the
    numbers were safe -- so the line names the player and the round it kept, or
    says why it could not.
    """
    submitted = {k: str(v) for k, v in (await request.form()).items()}
    player = submitted.get("player", "").strip()
    round_no = submitted.get("round_no", "").strip()
    # Named, not just "Saved": this line is swapped in out of band, so it can
    # land on a panel the tracker has already moved on from.
    where = f"{player} round {round_no}" if player and round_no else "that turn"

    try:
        entry, game_id, damage, errors = _validate_turn(
            request, storage, submitted, cross_checks=False
        )
    except _StaleTable:
        return _draft_status(request, f"Not kept — {_STALE_TABLE_MESSAGE}", bad=True)

    if entry is None or errors or game_id is None:
        why = next(iter(errors.values()), "the form was sent incomplete")
        return _draft_status(request, f"{where} not kept: {why}", bad=True)

    storage.save_turn(game_id, entry.player, entry.to_turn(damage))
    return _draft_status(request, f"Kept {where}")


@router.post("/final", response_class=HTMLResponse, name="entry_final")
async def save_final(request: Request, storage: StorageDep) -> HTMLResponse:
    """Save the death/win section for one player."""
    submitted = {k: str(v) for k, v in (await request.form()).items()}

    errors: dict[str, str] = {}
    entry: FinalEntry | None = None
    try:
        entry = FinalEntry.model_validate(submitted)
    except ValidationError as exc:
        errors = _errors_from(exc)

    event = load_event()
    scoring = load_scoring()
    event_id = _event_id(request)
    matches = list(range(1, event.games_per_player + 1))

    game_id = None
    if entry is not None:
        if entry.pod not in event.pods:
            errors["pod"] = f"unknown pod {entry.pod!r}"
        if entry.match_no not in matches:
            errors["match_no"] = f"match must be 1–{event.games_per_player}"
        if entry.placement is not None and entry.placement not in scoring.placement_points:
            valid = ", ".join(str(p) for p in sorted(scoring.placement_points))
            errors["placement"] = f"placement must be one of {valid}"
        game_id = storage.find_game(event_id, entry.pod, entry.match_no)
        seating = storage.seating(game_id) if game_id is not None else []
        if entry.player not in seating:
            errors["player"] = f"{entry.player!r} is not at this table"

    if entry is None or errors:
        ctx = _context(
            request,
            storage,
            submitted.get("pod"),
            _as_int(submitted.get("match_no")),
            submitted.get("player"),
            _as_int(submitted.get("round_no")),
            values=submitted,
            errors=errors,
        )
        return _panel(request, ctx, status_code=422)

    assert game_id is not None
    storage.save_final(game_id, entry.player, entry.to_final())
    await broadcaster.publish("stats-updated")

    if entry.placement is None:
        # A correction to someone still playing: stay on them.
        ctx = _context(
            request, storage, entry.pod, entry.match_no, entry.player,
            _as_int(submitted.get("round_no")),
            saved=f"{entry.player} updated",
        )
    else:
        # A death is usually recorded in the middle of somebody else's turn.
        # Go back to the game rather than leave the tracker on a player who
        # will not take another one.
        ctx = _context(
            request, storage, entry.pod, entry.match_no, None, None,
            saved=f"{entry.player} finished {_ordinal(entry.placement)}",
        )
    return _panel(request, ctx)


@router.post("/eliminations", response_class=HTMLResponse, name="entry_eliminations")
async def save_eliminations(request: Request, storage: StorageDep) -> HTMLResponse:
    """Record everybody a turn put out, in one submit.

    Parallel lists, like the decks form and for the same reason: a row is a
    select and two boxes, and the browser sends all three per row in document
    order, so `player[i]` owns `final_life[i]` and `total_graveyard[i]`. A row
    with nobody picked is skipped -- a tracker offered two rows because two
    kills were credited may only know one of the deaths yet.

    Placements are derived, not asked for. The rows are in the order the players
    went out, so the numbers follow from how many were still playing; see
    _finishing_order for the simultaneous case, which is the common one.
    """
    form = await request.form()
    pod = str(form.get("pod", ""))
    match_no = _as_int(form.get("match_no"))
    round_no = _as_int(form.get("round_no"))
    names = [str(n).strip() for n in form.getlist("player")]
    lives = [str(v) for v in form.getlist("final_life")]
    yards = [str(v) for v in form.getlist("total_graveyard")]
    simultaneous = bool(form.get("simultaneous"))
    winner = str(form.get("winner", "")).strip()

    event = load_event()
    scoring = load_scoring()
    event_id = _event_id(request)
    matches = list(range(1, event.games_per_player + 1))

    # Handed back to the form if this is refused, so the tracker's numbers are
    # still in the boxes. strict=False: unequal lists are refused below, and
    # this is only ever redrawn, never saved.
    elim: dict[str, Any] = {
        "rows": [
            {"player": n, "final_life": lv, "total_graveyard": y}
            for n, lv, y in zip(names, lives, yards, strict=False)
        ],
        "winner": {
            "player": winner,
            "final_life": str(form.get("winner_life", "")),
            "total_graveyard": str(form.get("winner_graveyard", "")),
        },
        "simultaneous": simultaneous,
    }

    errors: dict[str, str] = {}
    if pod not in event.pods:
        errors["pod"] = f"unknown pod {pod!r}"
    if match_no not in matches:
        errors["match_no"] = f"match must be 1–{event.games_per_player}"
    if not len(names) == len(lives) == len(yards):
        # Only reachable from a hand-built POST; the form sends all three per
        # row. Refused rather than zipped short, which would file a death
        # against somebody else's life total.
        errors["eliminations"] = "the form was sent incomplete: open the table again"

    def refuse() -> HTMLResponse:
        ctx = _context(
            request, storage, pod, match_no, None, round_no, errors=errors, elim=elim
        )
        return _panel(request, ctx, status_code=422)

    if errors:
        return refuse()

    game_id = storage.find_game(event_id, pod, match_no)
    seating = storage.seating(game_id) if game_id is not None else []
    out = _out(storage.stats_for_game(game_id)) if game_id is not None else {}
    still_in = len([n for n in seating if n not in out])

    submitted = [(n, lv, y) for n, lv, y in zip(names, lives, yards, strict=True) if n]

    seen: set[str] = set()
    for name, _, _ in submitted:
        if name not in seating:
            errors["eliminations"] = f"{name!r} is not at this table"
        elif name in out:
            # Rewriting a recorded placement from here would renumber the
            # finishing order around a death already inside it.
            errors["eliminations"] = (
                f"{name} is already recorded out — correct them in their own section"
            )
        elif name in seen:
            errors["eliminations"] = f"{name} is listed twice"
        seen.add(name)

    if winner and not errors:
        if winner not in seating:
            errors["eliminations"] = f"{winner!r} is not at this table"
        elif winner in out:
            errors["eliminations"] = f"{winner} is already recorded out"
        elif winner in seen:
            errors["eliminations"] = f"{winner} cannot both go out and win"

    if not errors and submitted and len(submitted) >= still_in:
        # Everybody still playing, listed as going out. The derived placements
        # would run all the way down to the best one and hand it to a player
        # who is dead -- the app inventing a winner for a game that had none.
        # This event has no draw, so that is the tracker's call to make, one
        # player at a time, rather than a number this form guesses.
        errors["eliminations"] = (
            "that would leave nobody standing: a game that ended without a "
            "winner goes in on each player's own form"
        )

    parsed: list[tuple[str, FinalEntry]] = []
    for row, (name, life, yard) in enumerate(submitted):
        payload = {
            "pod": pod, "match_no": str(match_no), "player": name,
            "final_life": life, "total_graveyard": yard,
        }
        try:
            parsed.append((name, FinalEntry.model_validate(payload)))
        except ValidationError as exc:
            keys = _elim_error_keys(row)
            for field, message in _errors_from(exc).items():
                errors.setdefault(keys.get(field, "eliminations"), message)

    winner_entry: FinalEntry | None = None
    if winner:
        payload = {
            "pod": pod, "match_no": str(match_no), "player": winner,
            "final_life": elim["winner"]["final_life"],
            "total_graveyard": elim["winner"]["total_graveyard"],
        }
        try:
            winner_entry = FinalEntry.model_validate(payload)
        except ValidationError as exc:
            keys = {"final_life": "winner_life", "total_graveyard": "winner_graveyard"}
            for field, message in _errors_from(exc).items():
                errors.setdefault(keys.get(field, "eliminations"), message)

    places: dict[str, int] = {}
    if not errors and parsed:
        places = _finishing_order(
            [(n, e.final_life) for n, e in parsed], still_in, simultaneous
        )
        unscored = sorted(p for p in set(places.values()) if p not in scoring.placement_points)
        if unscored:
            # More players going out than there are places left to finish in:
            # a stale form, or a row filled in for somebody already counted.
            errors["eliminations"] = (
                f"that would finish somebody {_ordinal(unscored[0])}, "
                "which this event does not score"
            )

    if errors:
        return refuse()

    if not parsed and winner_entry is None:
        # Every row left blank. Re-render rather than report a save that did
        # not happen -- the banner is the only proof the tracker gets.
        return _panel(request, _context(request, storage, pod, match_no, None, round_no))

    assert game_id is not None
    best = min(scoring.placement_points) if scoring.placement_points else 1
    finals = {
        name: FinalStat(
            placement=places[name],
            final_life=entry.final_life,
            total_graveyard=entry.total_graveyard,
        )
        for name, entry in parsed
    }
    if winner_entry is not None:
        finals[winner] = FinalStat(
            placement=best,
            final_life=winner_entry.final_life,
            total_graveyard=winner_entry.total_graveyard,
        )

    # One transaction: the placements are one fact about the finishing order,
    # and half of them written is an order no table played.
    storage.save_finals(game_id, finals)
    await broadcaster.publish("stats-updated")

    told = ", ".join(
        f"{name} won" if final.placement == best
        else f"{name} finished {_ordinal(final.placement)}"
        # Worst placement first, which is the order they went out in.
        for name, final in sorted(finals.items(), key=lambda kv: -kv[1].placement)
    )
    # Back to the table rather than onto a player who will not take another
    # turn, the same as a death saved on its own.
    ctx = _context(request, storage, pod, match_no, None, None, saved=told)
    return _panel(request, ctx)


def _as_int(v: Any) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None
