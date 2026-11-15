"""FastAPI application entrypoint.

Mounts routers, static files, and seeds the active event from config on startup.
"""
from __future__ import annotations

import pathlib
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from app.auth import ConfiguredSessionMiddleware, PasscodeMiddleware, require_configured
from app.config import load_auth, load_event, load_roster
from app.db import close_connections, get_storage, init_db
from app.routes import admin, auth, display, entry, results

BASE = pathlib.Path(__file__).parent


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Refuses to start on a missing or placeholder passcode — see app/auth.py.
    require_configured()

    init_db()
    storage = get_storage()
    event = load_event()
    # Config seeds the roster once, when the event row is first created; after
    # that the database is authoritative and `roster:` in config is ignored.
    # Keyed on created-the-event, not on an empty roster: an admin who deletes
    # every player and restarts must not get the config list back.
    app.state.event_id, created = storage.ensure_event(event.name, event.games_per_player)
    if created:
        storage.sync_roster(app.state.event_id, load_roster())

    # Which surfaces the passcode guards is config-driven; resolved once here so
    # the middleware doesn't re-read YAML on every request.
    app.state.protected_prefixes = load_auth().protected_prefixes()
    yield
    close_connections()


app = FastAPI(title="Commander Tracker", lifespan=lifespan)

# Order matters: add_middleware puts each new layer OUTERMOST, so the session
# must be added last to wrap the guard. Otherwise PasscodeMiddleware runs before
# the session is decoded and every request looks unauthenticated.
app.add_middleware(PasscodeMiddleware)
app.add_middleware(ConfiguredSessionMiddleware)

static_dir = BASE / "static"
static_dir.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=static_dir), name="static")

app.include_router(auth.router)
app.include_router(entry.router)
app.include_router(display.router)
app.include_router(results.router)
app.include_router(admin.router)


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return (
        "<h1>Commander Tracker</h1>"
        "<p>Surfaces: <a href='/entry'>/entry</a>, "
        "<a href='/admin'>/admin</a>, <a href='/display'>/display</a>.</p>"
    )
