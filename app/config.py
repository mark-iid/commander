"""Load event configuration from YAML into typed objects."""
from __future__ import annotations

import copy
import logging
import os
import pathlib
from dataclasses import dataclass

import yaml

from app.scoring import ScoringConfig

log = logging.getLogger(__name__)


def config_path() -> pathlib.Path:
    return pathlib.Path(os.environ.get("EVENT_CONFIG", "config/event.yaml"))


# (path, mtime_ns, size) -> parsed document. See load_raw().
_cache: tuple[pathlib.Path, int, int, dict] | None = None


def load_raw() -> dict:
    """The parsed event config, memoised on the file's own mtime and size.

    Every render calls two or three of the load_* helpers below, and each one
    used to re-read and re-parse the YAML from disk: two full parses to render a
    page, four to save an entry, and one per connected projector on every SSE
    push — the last of those on the event loop, since display._render runs
    there.

    Keyed on mtime+size rather than cached outright so editing event.yaml is
    still picked up on the next request instead of needing a restart, which is
    the same bargain app/assets.py strikes with the stylesheets. Callers get a
    copy, so the document cannot be mutated out from under the next reader.

    That same pickup means an edit made on the box mid-event is read while the
    editor is still writing it. A file that does not parse, or parses into
    something the loaders below cannot read, keeps the last good document in
    service rather than putting a 500 on every page and the projector until it
    is fixed. With no good document yet (startup), it raises as before.
    """
    global _cache
    path = config_path()
    if not path.exists():
        raise RuntimeError(
            f"event config not found at {path}. "
            "Copy config/event.example.yaml to config/event.yaml (or set EVENT_CONFIG)."
        )
    stat = path.stat()
    if _cache is not None:
        cached_path, mtime_ns, size, document = _cache
        if (cached_path, mtime_ns, size) == (path, stat.st_mtime_ns, stat.st_size):
            return copy.deepcopy(document)

    try:
        document = yaml.safe_load(path.read_text())
        _check(document)
    except Exception as exc:
        if _cache is None or _cache[0] != path:
            raise
        # Not cached under the new mtime, so the next request tries again and
        # the fixed file is picked up as soon as it is saved.
        log.warning("event config at %s is unusable, still serving the last good one: %s",
                    path, exc)
        return copy.deepcopy(_cache[3])
    _cache = (path, stat.st_mtime_ns, stat.st_size, document)
    return copy.deepcopy(document)


def _check(document: object) -> None:
    """Raise if the loaders below would fail on this document."""
    if not isinstance(document, dict):
        raise ValueError("not a YAML mapping")
    _event_from(document)
    _auth_from(document)
    ScoringConfig.from_dict(document)
    _roster_from(document)


def reset_cache() -> None:
    """For tests."""
    global _cache
    _cache = None


@dataclass(frozen=True)
class EventConfig:
    name: str
    games_per_player: int
    pods: list[str]
    # How many players sit at one pod. Optional: the entry form takes it from the
    # number of placement tiers when unset (see _expected_pod_size in
    # app/routes/entry.py). The roster says nothing about it: eight players can
    # be two pods of four for one match after another.
    pod_size: int | None = None


def load_event() -> EventConfig:
    return _event_from(load_raw())


def _event_from(document: dict) -> EventConfig:
    ev = document.get("event") or {}
    declared = ev.get("pod_size")
    return EventConfig(
        name=ev.get("name", "Commander Night"),
        games_per_player=int(ev.get("games_per_player", 3)),
        # Concurrent tables. One game per (pod, match).
        pods=[str(p) for p in ev.get("pods", ["A", "B"])],
        pod_size=int(declared) if declared else None,
    )


@dataclass(frozen=True)
class AuthConfig:
    protect_display: bool
    session_hours: int
    secure_cookies: bool

    def protected_prefixes(self) -> tuple[str, ...]:
        # /results is always guarded, even when the board is public: the CSV
        # carries per-game rows for named people, which is a step past the
        # standings the room can already see on the projector. Both paths are
        # listed because the matcher respects segment boundaries, so a
        # "/results" prefix deliberately does not cover "/results.csv".
        prefixes = ["/entry", "/admin", "/results", "/results.csv"]
        if self.protect_display:
            prefixes.append("/display")
        return tuple(prefixes)


def load_auth() -> AuthConfig:
    """Policy only. The passcode itself comes from TRACKER_PASSCODE — never YAML."""
    return _auth_from(load_raw())


def _auth_from(document: dict) -> AuthConfig:
    auth = document.get("auth") or {}
    return AuthConfig(
        protect_display=bool(auth.get("protect_display", False)),
        session_hours=int(auth.get("session_hours", 12)),
        secure_cookies=bool(auth.get("secure_cookies", False)),
    )


def load_scoring() -> ScoringConfig:
    return ScoringConfig.from_dict(load_raw())


def load_roster() -> list[str]:
    return _roster_from(load_raw())


def _roster_from(document: dict) -> list[str]:
    # `or []`: a roster key with every entry commented out parses as None.
    return [str(n) for n in document.get("roster") or []]
