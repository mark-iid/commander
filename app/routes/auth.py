"""Login / logout views for the shared passcode.

Deliberately outside the guarded prefixes — /login must stay reachable to
everyone, or there is no way in.
"""
from __future__ import annotations

from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from app.auth import (
    SESSION_KEY,
    check_passcode,
    client_key,
    is_safe_next,
    locked_for,
    record_failure,
    record_success,
)
from app.config import load_auth
from app.routes import templates

router = APIRouter(tags=["auth"])

DEFAULT_NEXT = "/entry"


def _insecure_transport(request: Request) -> str | None:
    """Warn when the session cookie cannot possibly survive this connection.

    `secure_cookies: true` marks the cookie Secure, and a browser silently
    refuses to store a Secure cookie delivered over plain HTTP. The login POST
    still succeeds and still redirects, but the next request arrives with no
    session, so the guard bounces straight back here — with no error, because
    nothing actually failed. From the tracker's side that is indistinguishable
    from a rejected passcode, which is exactly how it gets reported.

    Reachable in practice by going to the container directly (LAN IP, port 8000)
    instead of through the tunnel. request.url.scheme is trustworthy here because
    uvicorn runs with --proxy-headers, so a real HTTPS request through Cloudflare
    reports https.
    """
    if load_auth().secure_cookies and request.url.scheme != "https":
        return (
            "This page was served over plain HTTP, but sign-in cookies are set to "
            "HTTPS-only, so your browser will discard the session and send you "
            "back here even with the right passcode. Use the https:// address."
        )
    return None


@router.get("/login", response_class=HTMLResponse, name="login")
def login_form(request: Request, next: str = DEFAULT_NEXT) -> HTMLResponse:
    if request.session.get(SESSION_KEY):
        return RedirectResponse(_safe(next), status_code=303)
    return templates.TemplateResponse(
        request,
        "auth/login.html",
        {
            "request": request,
            "next": _safe(next),
            "error": None,
            "warning": _insecure_transport(request),
        },
    )


@router.post("/login", response_class=HTMLResponse, name="login_submit")
def login_submit(
    request: Request,
    passcode: str = Form(""),
    next: str = Form(DEFAULT_NEXT),
) -> HTMLResponse:
    target = _safe(next)
    key = client_key(request)

    wait = locked_for(key)
    if wait:
        return _deny(request, target, f"Too many attempts. Try again in {wait}s.", status=429)

    if not check_passcode(passcode):
        record_failure(key)
        return _deny(request, target, "Incorrect passcode.")

    record_success(key)
    # Fresh session id on privilege change, so a pre-login cookie can't be
    # replayed as an authenticated one (session fixation).
    request.session.clear()
    request.session[SESSION_KEY] = True
    return RedirectResponse(target, status_code=303)


@router.post("/logout", name="logout")
def logout(request: Request) -> RedirectResponse:
    request.session.clear()
    return RedirectResponse("/login", status_code=303)


def _safe(target: str) -> str:
    return target if is_safe_next(target) else DEFAULT_NEXT


def _deny(request: Request, target: str, message: str, status: int = 401) -> HTMLResponse:
    return templates.TemplateResponse(
        request,
        "auth/login.html",
        {
            "request": request,
            "next": target,
            "error": message,
            "warning": _insecure_transport(request),
        },
        status_code=status,
    )
