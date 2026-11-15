"""Public display surface — the projected leaderboard.

Read-only. Renders every configured prize with its current winner plus the win-point
standings, and pushes a fresh copy over SSE whenever a tracker saves an entry.

  GET /display         the projected page
  GET /display/stream  SSE; emits a `leaderboard` event carrying the rendered partial

The stream sends rendered HTML rather than JSON: the scoring engine already owns
who is winning, so the browser needs no logic and no client-side templating.
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from sse_starlette.sse import EventSourceResponse

from app.config import load_event, load_scoring
from app.db import get_storage
from app.events import broadcaster
from app.repository import Storage
from app.routes import StorageDep, templates
from app.scoring import build_standings, ranked_standings, resolve_prize


def _board_context(request: Request, storage: Storage) -> dict[str, Any]:
    event = load_event()
    scoring = load_scoring()
    event_id = request.app.state.event_id

    roster = storage.roster(event_id)
    stats = storage.all_stats(event_id)
    standings = build_standings(stats, scoring, roster)

    return {
        "request": request,
        "event": event,
        "prizes": [
            resolve_prize(p, standings, ineligible=scoring.prize_ineligible)
            for p in scoring.prizes
        ],
        # (rank, standing) pairs: ties share a rank rather than being
        # separated by sort order alone.
        "standings": ranked_standings(standings),
        "games_recorded": len({s.game_id for s in stats}),
        "rows_recorded": len(stats),
    }


router = APIRouter(prefix="/display", tags=["display"])


@router.get("", response_class=HTMLResponse, name="display_index")
def index(request: Request, storage: StorageDep) -> HTMLResponse:
    return templates.TemplateResponse(request, "display/index.html", _board_context(request, storage))


@router.get("/stream", name="display_stream")
async def stream(request: Request) -> EventSourceResponse:
    async def events() -> AsyncIterator[dict[str, str]]:
        # Render once up front so a browser that connects mid-event is correct
        # immediately rather than blank until the next save.
        yield {"event": "leaderboard", "data": _render(request)}
        # Disconnect handling is left to sse_starlette, which owns the receive
        # channel. Polling request.is_disconnected() here would put a second
        # consumer on that channel and race it. On disconnect this generator is
        # cancelled, and Broadcaster.subscribe's finally drops the queue.
        async for _ in broadcaster.subscribe():
            yield {"event": "leaderboard", "data": _render(request)}

    # sse_starlette's own ping keeps the connection alive through proxies.
    return EventSourceResponse(events())


def _render(request: Request) -> str:
    """Render the board partial to a string for the SSE payload.

    Storage is resolved per render rather than held across the stream's lifetime:
    an SSE connection lives for the whole event, and pinning one connection open
    that long would keep a stale handle after any reconnect.
    """
    storage = get_storage()
    ctx = _board_context(request, storage)
    return templates.get_template("display/_board.html").render(ctx)
