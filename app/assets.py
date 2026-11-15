"""Cache-busting URLs for static assets.

Cloudflare caches /static/*.css for four hours. A deploy that changes the
stylesheet therefore does not reach the room until the edge copy expires, and
the projector is the one screen nobody thinks to hard-reload -- the display sits
untouched all evening, which is exactly when a stale board matters most.

Appending a token derived from the file's own contents fixes that from the
server side: a changed file is requested at a URL the edge has never seen, so it
is fetched fresh, while an unchanged file keeps its URL and stays cached. No
purge step, no dashboard, nothing for the operator to remember on game night.

Content-derived rather than commit-derived because the container is deployed by
rsync and has no git metadata to read -- see the deploy job. Keying the cache on
mtime means editing a stylesheet during development is picked up on the next
render instead of needing a restart.
"""
from __future__ import annotations

import hashlib
import pathlib

STATIC_DIR = pathlib.Path(__file__).resolve().parent / "static"
STATIC_PREFIX = "/static/"

# path -> (mtime seen, digest of the contents at that mtime)
_versions: dict[pathlib.Path, tuple[float, str]] = {}


def asset_url(path: str) -> str:
    """`/static/app.css` -> `/static/app.css?v=1f4ae9c2`.

    Falls back to the bare path for anything that isn't a readable file under
    /static. A missing asset is the template's bug and the resulting 404 says so
    plainly; raising here would turn one wrong href into a 500 on every page.
    """
    if not path.startswith(STATIC_PREFIX):
        return path

    file = STATIC_DIR / path[len(STATIC_PREFIX):]
    try:
        mtime = file.stat().st_mtime
    except OSError:
        return path

    cached = _versions.get(file)
    if cached is None or cached[0] != mtime:
        digest = hashlib.sha256(file.read_bytes()).hexdigest()[:8]
        _versions[file] = (mtime, digest)
        cached = _versions[file]

    return f"{path}?v={cached[1]}"


def reset_cache() -> None:
    """For tests."""
    _versions.clear()
