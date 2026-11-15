"""Results sheet — the take-home record of a night.

Two representations of the same recorded state:

  GET /results            a page laid out for paper as much as for screen; the
                          PDF comes from the browser's own Save as PDF, which
                          keeps the event's look and costs no rendering dependency
  GET /results.csv        the per-player-per-game rows, for a spreadsheet
  GET /results/turns.csv  every individual turn, damage broken out per opponent
                          -- the event owner's own tracking sheet, filled in

Both describe whatever has been recorded so far rather than waiting for a
complete event, so the same URL is a mid-event snapshot after round one and the
final results after round three. The header says which it is; a sheet that
cannot tell you how much of the night it covers is worse than no sheet.

Always behind the passcode, unlike the projected board: the CSV carries
per-game rows for named people, which is a step past the standings a room can
already see.
"""
from __future__ import annotations

import csv
import io
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, StreamingResponse

from app.config import load_event, load_scoring
from app.models import GAME_STAT_FIELDS, TURN_FIELDS
from app.repository import Storage
from app.routes import StorageDep, templates
from app.scoring import build_standings, ranked_standings, resolve_prize

router = APIRouter(tags=["results"])

# match, pod and the two fields every row has, then each derived stat. "match"
# is the sheet's Match # (was "round", which now means a turn cycle).
#
# `commander` is the deck that player brought to that match, which is why it
# belongs on a per-game row and not on the standings: a player may bring a
# different one to each match, and their stats are summed across all of them
# regardless (commander damage travels with the person, not the deck).
CSV_HEADER = ["match", "pod", "player", "commander", "placement", "final_life"] + [
    f.name for f in GAME_STAT_FIELDS
]


def _event_id(request: Request) -> int:
    return int(request.app.state.event_id)


def _csv_response(buffer: io.StringIO, kind: str) -> StreamingResponse:
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    slug = "".join(c if c.isalnum() else "-" for c in load_event().name.lower()).strip("-")
    filename = f"{slug or 'event'}-{kind}-{stamp}.csv"
    return StreamingResponse(
        io.BytesIO(buffer.getvalue().encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _damage_matrix(storage: Storage, event_id: int, seating: dict[int, list[str]]) -> dict:
    """Per game: a dealer x target grid of combat damage, with both margins.

    The one view that only exists because damage is stored per opponent. Row
    totals are what a player dealt, column totals what they took -- so the
    archenemy of a match is the tallest column, which no per-game scalar could
    ever have told you.
    """
    raw = storage.damage_matrix(event_id)
    out: dict[int, dict[str, Any]] = {}
    for game_id, players in seating.items():
        pairs = raw.get(game_id, {})
        cell = {d: {t: pairs.get((d, t), 0) for t in players if t != d} for d in players}
        out[game_id] = {
            "players": players,
            "cell": cell,
            "dealt": {d: sum(cell[d].values()) for d in players},
            "taken": {t: sum(cell[d].get(t, 0) for d in players if d != t) for t in players},
            # A match where nobody connected renders as a wall of zeros that
            # says nothing; the sheet omits the grid entirely instead.
            "any": bool(pairs),
        }
    return out


def _context(request: Request, storage: Storage) -> dict[str, Any]:
    event_id = _event_id(request)
    event = load_event()
    scoring = load_scoring()
    roster = storage.roster(event_id)
    stats = storage.all_stats(event_id)
    standings = build_standings(stats, scoring, roster)

    games = {g.game_id: g for g in storage.games(event_id)}
    seating = {gid: storage.seating(gid) for gid in games}
    matrices = _damage_matrix(storage, event_id, seating)
    decks = storage.all_match_commanders(event_id)

    # Group the rows into the games they were played in, so the sheet can show
    # the night as it happened rather than only its totals. Keyed by game_id
    # rather than (match, pod) so each section can carry its damage grid.
    by_game: dict[int, list] = {}
    for stat in stats:
        if stat.game_id in games:
            by_game.setdefault(stat.game_id, []).append(stat)
    sections = []
    for game_id, rows in by_game.items():
        # Unfinished players sort last: placement is None until they are out,
        # and None is not orderable against int at all in Python 3.
        rows.sort(key=lambda s: (s.placement is None, s.placement or 0))
        game = games[game_id]
        sections.append({
            "match_no": game.match_no,
            "pod": game.pod,
            "rows": rows,
            "matrix": matrices.get(game_id),
            # Keyed by name alone, since a section is already one match.
            "commanders": {
                s.player: decks.get((s.player, game.match_no), "") for s in rows
            },
        })
    sections.sort(key=lambda s: (s["match_no"], s["pod"]))

    played = [s for s in standings if s.games_played]
    expected = len(roster) * event.games_per_player
    # Only FINISHED games count toward completeness. Every seated player has a
    # derived row from the moment their table is set, so counting rows would
    # call a match complete before a card had been played -- and "Final" is the
    # one claim on this sheet that must never be ahead of the truth.
    finished = [s for s in stats if s.placement is not None]

    return {
        "request": request,
        "event": event,
        "generated": datetime.now(),
        "standings": ranked_standings(standings),
        "prizes": [
            resolve_prize(p, standings, ineligible=scoring.prize_ineligible)
            for p in scoring.prizes
        ],
        "stat_fields": GAME_STAT_FIELDS,
        "sections": sections,
        "rows_recorded": len(finished),
        "rows_expected": expected,
        # "Complete" means every rostered player has every game *finished* — the
        # one claim this sheet must not overstate.
        "complete": bool(roster) and len(finished) >= expected and len(played) == len(roster),
        "players_started": len(played),
        "roster_size": len(roster),
    }


@router.get("/results", response_class=HTMLResponse, name="results")
def index(request: Request, storage: StorageDep) -> HTMLResponse:
    return templates.TemplateResponse(request, "results/index.html", _context(request, storage))


@router.get("/results.csv", name="results_csv")
def results_csv(request: Request, storage: StorageDep) -> StreamingResponse:
    event_id = _event_id(request)
    games = {g.game_id: g for g in storage.games(event_id)}
    decks = storage.all_match_commanders(event_id)

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(CSV_HEADER)
    rows = []
    for stat in storage.all_stats(event_id):
        game = games.get(stat.game_id)
        if game is None:
            continue
        rows.append([game.match_no, game.pod, stat.player,
                     decks.get((stat.player, game.match_no), ""),
                     stat.placement, stat.final_life]
                    + [getattr(stat, f.name) for f in GAME_STAT_FIELDS])
    # Sorted so two exports of the same data are byte-identical and diffable,
    # rather than however storage happened to return them. Indexes are into the
    # row above: match, pod, then placement -- which moved along one when
    # `commander` was inserted after the player's name.
    rows.sort(key=lambda r: (r[0], r[1], r[4] is None, r[4] or 0))
    writer.writerows(rows)

    return _csv_response(buffer, "results")


@router.get("/results/turns.csv", name="turns_csv")
def turns_csv(request: Request, storage: StorageDep) -> StreamingResponse:
    """Every turn of the night, one row each, damage broken out per opponent.

    Shaped after the event owner's own tracking sheet: a damage column per
    rostered player, because that is what makes the file readable in a
    spreadsheet without a pivot. A cell is blank when that player was not at
    the table for the match, and 0 when they were and took nothing -- a
    distinction a single zero would lose.

    This is the only export carrying turn-level detail; /results.csv aggregates
    it away, and until this existed the night's most detailed data never left
    the app at all.
    """
    event_id = _event_id(request)
    games = {g.game_id: g for g in storage.games(event_id)}
    roster = storage.roster(event_id)
    seating = {gid: set(storage.seating(gid)) for gid in games}

    header = (["match", "pod", "player", "round"]
              + [f"dmg_to_{name}" for name in roster]
              + ["round_combat_total"]
              + [f.name for f in TURN_FIELDS])

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(header)

    rows = []
    for rec in storage.all_turns(event_id):
        game = games.get(rec.game_id)
        if game is None:
            continue
        at_table = seating.get(rec.game_id, set())
        damage = [
            "" if (name not in at_table or name == rec.player)
            else rec.turn.damage.get(name, 0)
            for name in roster
        ]
        rows.append(
            [game.match_no, game.pod, rec.player, rec.turn.round_no]
            + damage
            + [sum(rec.turn.damage.values())]
            + [getattr(rec.turn, f.name) for f in TURN_FIELDS]
        )
    # Sorted so two exports of the same data are byte-identical and diffable,
    # rather than however storage happened to return them.
    rows.sort(key=lambda r: (r[0], r[1], r[3], r[2]))
    writer.writerows(rows)

    return _csv_response(buffer, "turns")
