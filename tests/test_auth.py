"""Shared-passcode session auth (build step 6).

The point of these is that /entry and /admin are genuinely unreachable without
the passcode — the failure mode this step exists to prevent is an
unauthenticated tracker being served to the internet.
"""
import pathlib
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import auth, db  # noqa: E402
from app.main import app  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
PASSCODE = "correct-horse-battery"


def _configure(tmp_path, monkeypatch, **auth_yaml):
    cfg = tmp_path / "event.yaml"
    text = (ROOT / "config" / "event.example.yaml").read_text()
    for key, value in auth_yaml.items():
        text = text.replace(f"{key}: false", f"{key}: {str(value).lower()}")
    cfg.write_text(text)
    monkeypatch.setenv("EVENT_CONFIG", str(cfg))
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("TRACKER_PASSCODE", PASSCODE)
    monkeypatch.setenv("SESSION_SECRET", "0" * 64)
    db.close_connections()
    auth.reset_throttle()


@pytest.fixture
def anon(tmp_path, monkeypatch):
    """A client that has not signed in."""
    _configure(tmp_path, monkeypatch)
    with TestClient(app) as c:
        yield c
    db.close_connections()


@pytest.fixture
def gated_display(tmp_path, monkeypatch):
    _configure(tmp_path, monkeypatch, protect_display=True)
    with TestClient(app) as c:
        yield c
    db.close_connections()


def _sign_in(client, passcode=PASSCODE):
    return client.post("/login", data={"passcode": passcode}, follow_redirects=False)


# --- the guard --------------------------------------------------------------

@pytest.mark.parametrize("path", ["/entry", "/entry/form", "/admin", "/admin/anything"])
def test_protected_paths_redirect_anonymous_users_to_login(anon, path):
    r = anon.get(path, follow_redirects=False)
    assert r.status_code == 303
    assert r.headers["location"].startswith("/login?next=")


def test_anonymous_post_cannot_write_data(anon):
    """The one that actually matters: no writes without the passcode."""
    r = anon.post("/entry/stat", data={"pod": "A", "round": "1", "player": "Alice",
                                       "placement": "1"}, follow_redirects=False)
    assert r.status_code == 303
    # sign in and confirm nothing was recorded by the rejected request
    _sign_in(anon)
    assert db.get_storage().all_stats(app.state.event_id) == []


def test_login_and_logout_round_trip(anon):
    r = _sign_in(anon)
    assert r.status_code == 303
    assert r.headers["location"] == "/entry"
    assert anon.get("/entry").status_code == 200

    assert anon.post("/logout", follow_redirects=False).status_code == 303
    assert anon.get("/entry", follow_redirects=False).status_code == 303


def test_wrong_passcode_is_rejected_and_grants_nothing(anon):
    r = _sign_in(anon, "hunter2")
    assert r.status_code == 401
    assert "Incorrect passcode" in r.text
    assert anon.get("/entry", follow_redirects=False).status_code == 303


def test_login_page_is_reachable_without_auth(anon):
    r = anon.get("/login")
    assert r.status_code == 200
    assert 'name="passcode"' in r.text


def test_static_assets_stay_public(anon):
    """The login page itself needs its stylesheet."""
    assert anon.get("/static/app.css").status_code == 200


def test_prefix_match_respects_path_boundaries(anon):
    """/entry must not gate an unrelated /entrypoint route."""
    assert auth._matches("/entry", ("/entry",))
    assert auth._matches("/entry/form", ("/entry",))
    assert not auth._matches("/entrypoint", ("/entry",))


# --- display gating is config-driven ----------------------------------------

def test_display_is_open_by_default(anon):
    assert anon.get("/display").status_code == 200


def test_display_can_be_gated_by_config(gated_display):
    assert gated_display.get("/display", follow_redirects=False).status_code == 303
    assert gated_display.get("/display/stream", follow_redirects=False).status_code == 303
    _sign_in(gated_display)
    assert gated_display.get("/display").status_code == 200


# --- redirect handling ------------------------------------------------------

def test_login_returns_the_user_to_where_they_were_going(anon):
    r = anon.get("/entry/form?pod=B&round=2", follow_redirects=False)
    target = r.headers["location"]
    assert "pod%3DB" in target or "pod=B" in target

    r2 = anon.post("/login", data={"passcode": PASSCODE, "next": "/entry/form?pod=B&round=2"},
                   follow_redirects=False)
    assert r2.headers["location"] == "/entry/form?pod=B&round=2"


@pytest.mark.parametrize("evil", ["https://evil.example.com", "//evil.example.com", "http://x"])
def test_next_cannot_be_an_open_redirect(anon, evil):
    r = anon.post("/login", data={"passcode": PASSCODE, "next": evil}, follow_redirects=False)
    assert r.headers["location"] == "/entry"


def test_htmx_requests_get_hx_redirect_not_a_page_swap(anon):
    """A 303 would make htmx swap the login page into the form element."""
    r = anon.post("/entry/stat", data={}, headers={"HX-Request": "true"},
                  follow_redirects=False)
    assert r.status_code == 401
    assert r.headers["HX-Redirect"].startswith("/login")
    assert "<form" not in r.text


def test_a_save_that_bounces_comes_back_to_the_page_not_the_post(anon):
    """A session that lapsed mid-save used to log the tracker back in onto
    GET /entry/turn, a bare 405."""
    r = anon.post("/entry/turn", data={}, follow_redirects=False, headers={
        "HX-Request": "true",
        "HX-Current-URL": "https://tracker.example/entry?pod=B&match_no=2"})
    assert r.headers["HX-Redirect"] == "/login?next=%2Fentry%3Fpod%3DB%26match_no%3D2"

    signed_in = anon.post("/login", data={"passcode": PASSCODE, "next": "/entry?pod=B&match_no=2"},
                          follow_redirects=False)
    assert signed_in.headers["location"] == "/entry?pod=B&match_no=2"


@pytest.mark.parametrize("method, path, home", [
    ("post", "/entry/final", "/entry"),
    ("post", "/admin/players", "/admin"),
])
def test_a_bounced_post_without_htmx_goes_to_the_top_of_its_section(anon, method, path, home):
    r = getattr(anon, method)(path, data={}, follow_redirects=False)
    assert r.headers["location"] == "/login?next=" + home.replace("/", "%2F")


def test_a_bounced_page_load_still_comes_back_to_that_page(anon):
    r = anon.get("/results?x=1", follow_redirects=False)
    assert r.headers["location"] == "/login?next=%2Fresults%3Fx%3D1"


# --- throttling -------------------------------------------------------------

def test_repeated_failures_are_throttled(anon):
    for _ in range(auth.LOCKOUT_AFTER):
        assert _sign_in(anon, "wrong").status_code == 401
    r = _sign_in(anon, "wrong")
    assert r.status_code == 429
    assert "Too many attempts" in r.text
    # even the correct passcode is refused while locked out
    assert _sign_in(anon).status_code == 429


def test_successful_login_clears_the_failure_count(anon):
    for _ in range(auth.LOCKOUT_AFTER - 1):
        _sign_in(anon, "wrong")
    assert _sign_in(anon).status_code == 303
    # a fresh run of failures gets the full allowance again
    for _ in range(auth.LOCKOUT_AFTER - 1):
        assert _sign_in(anon, "wrong").status_code == 401


# --- configuration guard ----------------------------------------------------

@pytest.mark.parametrize("value", ["", "change-me"])
def test_app_refuses_to_start_without_a_real_passcode(tmp_path, monkeypatch, value):
    _configure(tmp_path, monkeypatch)
    monkeypatch.setenv("TRACKER_PASSCODE", value)
    with pytest.raises(RuntimeError, match="TRACKER_PASSCODE"):
        with TestClient(app):
            pass


def test_app_refuses_to_start_without_a_session_secret(tmp_path, monkeypatch):
    _configure(tmp_path, monkeypatch)
    monkeypatch.setenv("SESSION_SECRET", "change-me")
    with pytest.raises(RuntimeError, match="SESSION_SECRET"):
        with TestClient(app):
            pass


def test_session_cookie_is_signed_and_opaque(anon):
    _sign_in(anon)
    cookie = anon.cookies.get("session")
    assert cookie
    # the flag must not be readable/forgeable as plaintext
    assert "authed" not in cookie


# --- the silent bounce: Secure cookies over plain HTTP --------------------------
#
# Reported as "the passcode I set does not seem to be working". Nothing was wrong
# with the passcode: with secure_cookies on, a browser discards the Secure session
# cookie delivered over http, so the POST succeeded, the redirect fired, the guard
# saw no session and sent the tracker back to /login with no error at all.

def _secure_cookie_client(tmp_path, monkeypatch):
    _configure(tmp_path, monkeypatch, secure_cookies=True)
    return TestClient(app)


def _secure_https_client(tmp_path, monkeypatch):
    """Same app, but the ASGI scope says https.

    base_url rather than an X-Forwarded-Proto header: that header is turned into
    the scope's scheme by uvicorn's --proxy-headers (set in the systemd unit),
    which TestClient does not run, so a header here would prove nothing.
    """
    _secure_cookie_client(tmp_path, monkeypatch)
    return TestClient(app, base_url="https://commander.example.org")


def test_login_over_plain_http_warns_when_cookies_are_https_only(tmp_path, monkeypatch):
    with _secure_cookie_client(tmp_path, monkeypatch) as c:
        body = c.get("/login").text
        assert "HTTPS-only" in body
        assert "transport-warning" in body


def test_the_warning_is_absent_over_https(tmp_path, monkeypatch):
    with _secure_https_client(tmp_path, monkeypatch) as c:
        assert "HTTPS-only" not in c.get("/login").text


def test_the_warning_is_absent_when_secure_cookies_are_off(anon):
    """The plain-HTTP LAN deployment is a supported configuration, not a fault."""
    assert "HTTPS-only" not in anon.get("/login").text


def test_a_wrong_passcode_over_plain_http_shows_both(tmp_path, monkeypatch):
    """The warning explains a bounce; it must not mask a genuinely wrong code."""
    with _secure_cookie_client(tmp_path, monkeypatch) as c:
        r = c.post("/login", data={"passcode": "nope"}, follow_redirects=False)
        assert r.status_code == 401
        assert "Incorrect passcode." in r.text
        assert "HTTPS-only" in r.text


def test_the_correct_passcode_still_works_over_https(tmp_path, monkeypatch):
    """The warning must not be the only thing standing between a tracker and a
    working sign-in — over https the whole flow still completes.

    Deliberately does not assert the cookie's Secure flag. Starlette builds the
    middleware stack once per process and caches it, so `secure_cookies` is
    fixed by whichever test starts the app first and an assertion here would
    pass or fail on test ordering rather than on behaviour. That the live
    deployment sets Secure was confirmed against the running service instead.
    """
    with _secure_https_client(tmp_path, monkeypatch) as c:
        r = c.post("/login", data={"passcode": PASSCODE}, follow_redirects=False)
        assert r.status_code == 303
        assert r.headers["location"] == "/entry"
