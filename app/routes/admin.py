"""Roster admin surface.

Config seeds the roster once on a brand-new event (see app/main.py); after that
this surface owns it. Add, rename, set commander, delete.

Deletion is refused for any player with recorded stats: game_player_stats has
ON DELETE CASCADE, so allowing it would silently destroy that player's game
history. Renaming is always safe — stats key on player_id, not name.

Every mutation publishes on the event bus. The projected display builds its
standings from the roster, so a rename that did not publish would leave a stale
name on the projector until the next stat save.

The danger zone resets the event. It is two-step on purpose: the first click
only asks the server what would be destroyed, and the confirmation names the
real counts before anything is deleted. A one-click reset next to the roster
controls is a misclick away from ending a live event.

Endpoints:
  GET  /admin                            full page
  POST /admin/players                    add
  POST /admin/players/{id}               rename / set commander
  POST /admin/players/{id}/delete        delete, refused if stats exist
  GET  /admin/reset                      danger zone, idle
  GET  /admin/reset/confirm?scope=...    danger zone, armed, with real counts
  POST /admin/reset                      do it
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse
from starlette.datastructures import FormData

from app.config import load_event, load_roster, load_scoring
from app.db import BackupFailed, backup_database
from app.events import broadcaster
from app.models import COMMANDER_MAX, Player
from app.repository import SQLITE_INT_MAX, DuplicatePlayerName, Storage
from app.routes import StorageDep, templates

router = APIRouter(prefix="/admin", tags=["admin"])

_ROSTER_CHANGED = "roster-changed"
_STATS_CHANGED = "stats-updated"

# The two reset levels, mirroring scripts/reset.py. Keep them in step.
RESET_SCOPES = ("results", "all")

# Mirrored by maxlength= on the inputs, but enforced here: maxlength is a
# client-side hint, and an unbounded name reaches the projected display.
NAME_MAX = 60
# COMMANDER_MAX comes from models.py rather than being restated here:
# /entry/commanders bounds the same field, and the two limits drifting would let
# a per-match deck name through that the roster refuses.

_GONE = "That player is no longer on the roster."

# SQLite stores INTEGER as signed 64-bit and raises OverflowError — before the
# query runs, so no driver-level guard catches it — on anything wider. Only the
# upper bound is checked: isdecimal() is False for "-1", so nothing negative
# ever reaches the comparison.
# The widest value storage can bind is a storage fact, not a route's to know
# (ADR 0001) — imported from the repository rather than restated here.
_SQLITE_INT_MAX = SQLITE_INT_MAX


def _event_id(request: Request) -> int:
    return request.app.state.event_id


def _field(form: FormData, key: str) -> str:
    """Form values arrive as str or UploadFile; coerce and strip so a name is
    never stored with surrounding whitespace."""
    value = form.get(key)
    return value.strip() if isinstance(value, str) else ""


def _field_error(name: str, commander: str) -> str | None:
    if not name:
        return "Name is required."
    if len(name) > NAME_MAX:
        return f"Name must be {NAME_MAX} characters or fewer."
    if len(commander) > COMMANDER_MAX:
        return f"Commander must be {COMMANDER_MAX} characters or fewer."
    return None


def _resolve(request: Request, storage: Storage, raw_player_id: str) -> Player | None:
    """Path segment -> Player, or None.

    The id is taken as a string and parsed here rather than declared `int`. A
    declared int makes FastAPI answer a bad segment with its own JSON validation
    body, and base.html tells htmx to swap 422s — so `POST /admin/players/abc`
    would replace the roster region with raw JSON and cost the operator their
    page. FastAPI's exception handlers are app-scoped, so the alternative was a
    global handler sniffing the path; parsing one segment locally is smaller.

    The parse is strict on purpose, because `int()` alone is far more permissive
    than a path segment should be. It succeeds on values too wide for SQLite,
    which then raise OverflowError inside get_player() — before the query runs,
    so no repository-level guard catches it — and surface as a 500 rather than
    as this helper's polite 422. That is what the range check below is for. It
    also accepts `" 12 "`, `"1_2"` and non-ASCII digits like `"١٢"`; those were
    harmless, since every result still goes through the event-scoped
    get_player(), but a path segment has no business meaning any of them.

    `isascii()` is not redundant with `isdecimal()`: `"١٢".isdecimal()` is True
    and `int("١٢")` is 12, so isdecimal alone would let those through.

    The three guards below are each load-bearing: isdecimal() establishes the
    shape, the `except` catches CPython's 4300-digit ceiling on int() — which a
    string of nines sails past both predicates to hit — and the range check
    catches what SQLite cannot bind. A length cap would subsume the last two
    more cheaply, but it would also reject zero-padded ids, which resolve today.
    """
    if not (raw_player_id.isascii() and raw_player_id.isdecimal()):
        return None
    try:
        player_id = int(raw_player_id)
    except ValueError:
        return None
    if player_id > _SQLITE_INT_MAX:
        return None
    return storage.get_player(_event_id(request), player_id)


def _reset_context(
    request: Request,
    storage: Storage,
    *,
    armed: str | None = None,
    notice: str | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    """State for the danger zone. `armed` is the scope awaiting confirmation."""
    event_id = _event_id(request)
    games, stat_rows = storage.count_results(event_id)
    return {
        "request": request,
        "armed": armed,
        "games": games,
        "stat_rows": stat_rows,
        "player_count": len(storage.roster(event_id)),
        # What --all would put back. Named so the confirmation can be honest
        # about the outcome instead of just promising deletion.
        "seed_roster": load_roster(),
        "reset_notice": notice,
        "reset_error": error,
    }


def _reset_panel(
    request: Request,
    storage: Storage,
    *,
    armed: str | None = None,
    notice: str | None = None,
    error: str | None = None,
    status_code: int = 200,
) -> HTMLResponse:
    ctx = _reset_context(request, storage, armed=armed, notice=notice, error=error)
    return templates.TemplateResponse(
        request, "admin/_reset.html", ctx, status_code=status_code
    )


def _context(
    request: Request,
    storage: Storage,
    *,
    error: str | None = None,
    notice: str | None = None,
    form: dict[str, str] | None = None,
) -> dict[str, Any]:
    return {
        **_reset_context(request, storage),
        "request": request,
        "event": load_event(),
        "players": storage.players(_event_id(request)),
        "error": error,
        "notice": notice,
        # Carries back what the operator typed on a failed add, so a rejected
        # submission does not blank the boxes they have to retype.
        "form": form or {"name": "", "commander": ""},
    }


def _roster(
    request: Request,
    storage: Storage,
    *,
    error: str | None = None,
    notice: str | None = None,
    form: dict[str, str] | None = None,
    status_code: int = 200,
) -> HTMLResponse:
    ctx = _context(request, storage, error=error, notice=notice, form=form)
    return templates.TemplateResponse(
        request, "admin/_roster.html", ctx, status_code=status_code
    )


@router.get("", response_class=HTMLResponse, name="admin_index")
def index(request: Request, storage: StorageDep) -> HTMLResponse:
    return templates.TemplateResponse(request, "admin/index.html", _context(request, storage))


@router.post("/players", response_class=HTMLResponse, name="admin_add_player")
async def add_player(request: Request, storage: StorageDep) -> HTMLResponse:
    form = await request.form()
    name = _field(form, "name")
    commander = _field(form, "commander")
    typed = {"name": name, "commander": commander}

    problem = _field_error(name, commander)
    if problem is not None:
        return _roster(request, storage, error=problem, form=typed, status_code=422)

    try:
        storage.add_player(_event_id(request), name, commander or None)
    except DuplicatePlayerName:
        return _roster(
            request,
            storage,
            error=f"A player named {name!r} is already on the roster.",
            form=typed,
            status_code=422,
        )

    await broadcaster.publish(_ROSTER_CHANGED)
    return _roster(request, storage, notice=f"Added {name}.")


@router.post("/players/{player_id}", response_class=HTMLResponse, name="admin_update_player")
async def update_player(
    request: Request, storage: StorageDep, player_id: str
) -> HTMLResponse:
    form = await request.form()
    name = _field(form, "name")
    commander = _field(form, "commander")

    # Scoped by event: a stale tab or a hand-crafted post must not reach a
    # player belonging to another event.
    player = _resolve(request, storage, player_id)
    if player is None:
        return _roster(request, storage, error=_GONE, status_code=422)

    problem = _field_error(name, commander)
    if problem is not None:
        return _roster(
            request,
            storage,
            error=f"{player.name} was not changed. {problem}",
            status_code=422,
        )

    # prize_ineligible names players as text in event.yaml, so a rename here
    # would quietly make an excluded player eligible again. Listing the new
    # name in the config first is what lets the rename through.
    ineligible = load_scoring().prize_ineligible
    if name != player.name and player.name in ineligible and name not in ineligible:
        return _roster(
            request,
            storage,
            error=(
                f"{player.name} was not renamed: they are excluded from prizes by name "
                f"(prize_ineligible in event.yaml). Add {name!r} there first."
            ),
            status_code=422,
        )

    try:
        storage.update_player(_event_id(request), player.player_id, name, commander or None)
    except DuplicatePlayerName:
        return _roster(
            request,
            storage,
            error=f"A player named {name!r} is already on the roster.",
            status_code=422,
        )

    await broadcaster.publish(_ROSTER_CHANGED)
    return _roster(request, storage, notice=f"Saved {name}.")


@router.post(
    "/players/{player_id}/delete", response_class=HTMLResponse, name="admin_delete_player"
)
async def delete_player(
    request: Request, storage: StorageDep, player_id: str
) -> HTMLResponse:
    player = _resolve(request, storage, player_id)
    if player is None:
        return _roster(request, storage, error=_GONE, status_code=422)

    # Pre-check only so the operator gets the specific reason. The refusal itself
    # is the database's, below — this check cannot be trusted to still hold by
    # the time the delete runs.
    if storage.player_has_stats(player.player_id):
        return _roster(
            request,
            storage,
            error=(
                f"{player.name} is part of a game and cannot be deleted: it would "
                "take their seat and stats with them. Rename them instead, or "
                "reseat that table without them."
            ),
            status_code=422,
        )

    # A False here means the row was not removed, and "has stats" is only one of
    # the reasons — another admin deleting the same player first also lands here.
    # Naming a cause we did not establish would be a lie in a two-admin race, so
    # the message stays generic and points at the freshly rendered roster.
    if not storage.delete_player(_event_id(request), player.player_id):
        return _roster(
            request,
            storage,
            error=f"{player.name} could not be deleted. The roster below is current.",
            status_code=422,
        )

    await broadcaster.publish(_ROSTER_CHANGED)
    return _roster(request, storage, notice=f"Deleted {player.name}.")


# --- danger zone -------------------------------------------------------------
#
# Two steps, both server-rendered. The GET arms the panel and reports what is
# actually in the database right now; the POST carries the scope it was armed
# with. An hx-confirm dialog would have been one line, but it can only promise
# "this will reset everything" — it cannot tell the operator they are about to
# lose 24 stat rows across 6 games, which is the number that makes somebody stop
# and think. Arming is a GET on purpose: it reads and changes nothing, so a
# double-click, a refresh or a stray prefetch cannot destroy anything.


@router.get("/reset", response_class=HTMLResponse, name="admin_reset_panel")
def reset_panel(request: Request, storage: StorageDep) -> HTMLResponse:
    """The idle panel. Also the Cancel target."""
    return _reset_panel(request, storage)


@router.get("/reset/confirm", response_class=HTMLResponse, name="admin_reset_confirm")
def reset_confirm(
    request: Request, storage: StorageDep, scope: str = Query("results")
) -> HTMLResponse:
    if scope not in RESET_SCOPES:
        return _reset_panel(request, storage, error="Unknown reset type.", status_code=422)
    return _reset_panel(request, storage, armed=scope)


@router.post("/reset", response_class=HTMLResponse, name="admin_reset")
async def reset(request: Request, storage: StorageDep) -> HTMLResponse:
    form = await request.form()
    scope = _field(form, "scope")
    if scope not in RESET_SCOPES:
        return _reset_panel(request, storage, error="Unknown reset type.", status_code=422)

    event_id = _event_id(request)

    # Always, and before anything is deleted. The operator has confirmed, which
    # is not the same as being right.
    try:
        backup = backup_database().name
    except BackupFailed as exc:
        return _reset_panel(
            request,
            storage,
            armed=scope,
            error=f"Could not write a backup, so nothing was deleted: {exc}",
            status_code=422,
        )

    games, stat_rows = storage.clear_results(event_id)
    done = (
        f"Deleted {stat_rows} stat row{'' if stat_rows == 1 else 's'} "
        f"across {games} game{'' if games == 1 else 's'}"
    )

    if scope == "all":
        removed = storage.clear_roster(event_id)
        # The event row is deliberately kept: app.state.event_id is cached for
        # the process lifetime, so deleting it would break every save until
        # someone restarted the service. Reseeding gives the same clean slate
        # without that.
        storage.sync_roster(event_id, load_roster())
        restored = len(storage.roster(event_id))
        done += (
            f"; removed {removed} player{'' if removed == 1 else 's'} "
            f"and reseeded {restored} from config"
        )

    # Both surfaces are stale now. The display rebuilds standings from the
    # roster as well as the stats, so a results-only reset still has to say so.
    await broadcaster.publish(_STATS_CHANGED)
    if scope == "all":
        await broadcaster.publish(_ROSTER_CHANGED)

    ctx = _context(
        request, storage, notice="Roster reset from config." if scope == "all" else None
    )
    ctx.update(_reset_context(request, storage, notice=f"{done}. Backup saved as {backup}."))
    return templates.TemplateResponse(request, "admin/_reset_done.html", ctx)
