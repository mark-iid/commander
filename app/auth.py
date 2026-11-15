"""Shared-passcode session auth (ADR 0001, decision 6).

No user accounts: one passcode, held in the environment, exchanged for a signed
session cookie. That matches the trust model of a private game night while still
being safe to expose, and Cloudflare Access is the recommended second layer.

The passcode never lives in config/event.yaml — only which surfaces it guards
does. Secrets stay in the environment.
"""
from __future__ import annotations

import hmac
import os
import time
from dataclasses import dataclass
from urllib.parse import quote, urlsplit

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware
from starlette.requests import Request
from starlette.responses import RedirectResponse, Response

SESSION_KEY = "authed"

# Values that mean "nobody configured this yet". Treated as fatal at startup
# rather than quietly running an unauthenticated tracker on the internet.
_PLACEHOLDERS = {"", "change-me", "changeme"}

# Brute-force throttle. Deliberately short: behind a Cloudflare Tunnel every
# request can share one source address, so a long lockout would take the whole
# room offline. 60s is enough to make guessing impractical without turning a
# fat-fingered tracker into an outage.
LOCKOUT_AFTER = 5
LOCKOUT_SECONDS = 60


def passcode() -> str:
    return os.environ.get("TRACKER_PASSCODE", "")


def session_secret() -> str:
    return os.environ.get("SESSION_SECRET", "")


def require_configured() -> None:
    """Fail fast at startup. An unauthenticated /entry is the exact failure this
    build step exists to prevent, so it must not be reachable by accident."""
    if passcode() in _PLACEHOLDERS:
        raise RuntimeError(
            "TRACKER_PASSCODE is unset or still the placeholder. Set it in .env "
            "(or the environment) before starting — /entry and /admin will not "
            "be served without it."
        )
    if session_secret() in _PLACEHOLDERS:
        raise RuntimeError(
            "SESSION_SECRET is unset or still the placeholder. Generate one with: "
            'python -c "import secrets;print(secrets.token_hex(32))"'
        )


def check_passcode(candidate: str) -> bool:
    # Constant-time: the passcode is short and shared, so a timing oracle is a
    # realistic way to shorten a guessing attack.
    return hmac.compare_digest(candidate.encode(), passcode().encode())


# --- throttling -------------------------------------------------------------

@dataclass
class _Attempts:
    fails: int = 0
    locked_until: float = 0.0
    last_seen: float = 0.0


_attempts: dict[str, _Attempts] = {}

# A failure streak that has gone quiet for this long stops counting. Without it
# `fails` only ever rises, so four typos spread across a whole game night leave
# a tracker one typo away from a lockout they did nothing to earn.
ATTEMPT_TTL = 900

# Hard ceiling on how many callers are tracked at once. See _evict().
MAX_TRACKED = 4096

# Throttle keys are attacker-controlled (see client_key), so they are truncated
# before being used as dict keys. Comfortably longer than an IPv6 address.
KEY_MAX = 64


def client_key(request: Request) -> str:
    """Identify the caller for throttling.

    CF-Connecting-IP is only meaningful when the app really is behind Cloudflare;
    it is attacker-controlled otherwise. That is acceptable for *auth*, because
    the header can only ever split the throttle bucket, never bypass the
    passcode — but it is the reason `_attempts` has to be bounded. A rotating
    header value adds a dict entry per request, and this process is the only
    worker the event has. Truncation caps one entry; _evict() caps their number.
    """
    cf = request.headers.get("CF-Connecting-IP")
    if cf:
        return cf[:KEY_MAX]
    host = request.client.host if request.client else "unknown"
    return host[:KEY_MAX]


def _evict(now: float) -> None:
    """Forget callers who are no longer being restrained.

    Two passes, because they answer different questions. The first drops entries
    that have expired on their own merits — not locked, and quiet for
    ATTEMPT_TTL. The second is the backstop for a caller cycling the header
    faster than entries expire: it trims to MAX_TRACKED, dropping the least
    recently seen first. Active lockouts sort last and so survive the trim,
    which matters — evicting a lockout would hand back the guesses it took to
    earn it.
    """
    for key, attempt in list(_attempts.items()):
        if attempt.locked_until <= now and attempt.last_seen <= now - ATTEMPT_TTL:
            del _attempts[key]

    if len(_attempts) > MAX_TRACKED:
        ranked = sorted(_attempts.items(), key=lambda kv: (kv[1].locked_until, kv[1].last_seen))
        for key, _ in ranked[: len(_attempts) - MAX_TRACKED]:
            del _attempts[key]


def locked_for(key: str) -> int:
    """Seconds remaining on a lockout, or 0."""
    a = _attempts.get(key)
    if a is None:
        return 0
    remaining = a.locked_until - time.monotonic()
    return int(remaining) + 1 if remaining > 0 else 0


def record_failure(key: str) -> None:
    now = time.monotonic()
    a = _attempts.setdefault(key, _Attempts())
    a.last_seen = now
    a.fails += 1
    if a.fails >= LOCKOUT_AFTER:
        a.locked_until = now + LOCKOUT_SECONDS
        a.fails = 0
    # This is the only path that grows `_attempts`, so it is the only one that
    # has to prune it. After the insert, so the ceiling counts the entry just
    # added; that entry is the most recently seen, so the trim never takes it.
    _evict(now)


def record_success(key: str) -> None:
    _attempts.pop(key, None)


def reset_throttle() -> None:
    """For tests."""
    _attempts.clear()


# --- middleware -------------------------------------------------------------

def is_safe_next(target: str) -> bool:
    """Only same-site relative paths, so ?next= can't be an open redirect."""
    return target.startswith("/") and not target.startswith("//")


class ConfiguredSessionMiddleware(SessionMiddleware):
    """SessionMiddleware that reads its settings when the middleware stack is
    built rather than at import time.

    Passing `secret_key=session_secret()` directly to add_middleware would
    evaluate at import, before `.env` is loaded or a test fixture has set the
    environment — yielding an empty signing key.
    """

    def __init__(self, app):
        from app.config import load_auth  # local: avoids an import cycle

        cfg = load_auth()
        super().__init__(
            app,
            secret_key=session_secret(),
            max_age=cfg.session_hours * 3600,
            same_site="lax",
            # Secure cookies require HTTPS. Off by default because the LAN
            # deployment is plain HTTP; turn on once it's behind the tunnel.
            https_only=cfg.secure_cookies,
        )


class PasscodeMiddleware(BaseHTTPMiddleware):
    """Guards the prefixes listed in `app.state.protected_prefixes`.

    Which prefixes those are is decided at startup from config (see
    `config.load_auth`), so gating the public display is a YAML edit.
    """

    async def dispatch(self, request: Request, call_next):
        prefixes: tuple[str, ...] = getattr(request.app.state, "protected_prefixes", ())
        path = request.url.path

        if _matches(path, prefixes) and not request.session.get(SESSION_KEY):
            return _challenge(request)
        return await call_next(request)


def _matches(path: str, prefixes: tuple[str, ...]) -> bool:
    # Prefix match on a path segment boundary, so /entrypoint is not treated as
    # part of /entry.
    return any(path == p or path.startswith(p + "/") for p in prefixes)


def _challenge(request: Request) -> Response:
    login_url = "/login?next=" + quote(_come_back_to(request), safe="")

    if request.headers.get("HX-Request") == "true":
        # A 303 here would make htmx swap the login page into whatever element
        # triggered the request. HX-Redirect makes the browser navigate instead.
        response = Response(status_code=401)
        response.headers["HX-Redirect"] = login_url
        return response

    return RedirectResponse(login_url, status_code=303)


def _come_back_to(request: Request) -> str:
    """Where to land after logging in: the page, never the request that bounced.

    A save (a POST) or an htmx partial is not somewhere a browser can be sent
    back to: a session that lapsed mid-save used to log the tracker in and then
    303 them to GET /entry/turn, which is a bare 405. htmx names the page it
    was on in HX-Current-URL; failing that, the top of the section.
    """
    is_htmx = request.headers.get("HX-Request") == "true"
    if request.method == "GET" and not is_htmx:
        target = request.url.path
        if request.url.query:
            target += "?" + request.url.query
        return target
    page = urlsplit(request.headers.get("HX-Current-URL", ""))
    if is_htmx and page.path.startswith("/"):
        return page.path + (f"?{page.query}" if page.query else "")
    return "/" + request.url.path.strip("/").split("/")[0]
