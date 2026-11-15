"""Cache-busting asset URLs.

The bug being prevented is invisible from inside the app: every template
renders, every test passes, the deploy job goes green, and the room still sees
the previous stylesheet because Cloudflare holds /static/*.css for four hours.
The only defence is that a changed file gets a URL the edge has never seen, so
that is what these tests pin down — including the part that is easy to get
backwards, that an *unchanged* file must keep its URL, or every deploy
needlessly re-fetches every asset.
"""
from __future__ import annotations

import contextlib
import pathlib
import re
import shutil
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import db  # noqa: E402
from app.assets import STATIC_DIR, asset_url, reset_cache  # noqa: E402
from app.main import app  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
PASSCODE = "test-passcode"
VERSIONED = re.compile(r"/static/[\w.-]+\?v=[0-9a-f]{8}")


@pytest.fixture(autouse=True)
def _clean_cache():
    reset_cache()
    yield
    reset_cache()


# --- the token --------------------------------------------------------------

def test_a_real_asset_gets_a_content_token():
    assert VERSIONED.fullmatch(asset_url("/static/app.css"))


def test_the_token_is_stable_while_the_file_is():
    """An unchanged asset must keep its URL, or every deploy busts every file."""
    assert asset_url("/static/app.css") == asset_url("/static/app.css")


def test_the_token_follows_the_contents(tmp_path, monkeypatch):
    scratch = STATIC_DIR / "_version_probe.css"
    scratch.write_text("a{color:red}")
    try:
        first = asset_url("/static/_version_probe.css")
        # A new mtime alone must not be enough — the token tracks contents.
        scratch.write_text("a{color:blue}")
        second = asset_url("/static/_version_probe.css")
    finally:
        scratch.unlink()
    assert first != second
    assert VERSIONED.fullmatch(second)


def test_identical_contents_produce_an_identical_token():
    probe = STATIC_DIR / "_version_probe.css"
    probe.write_text("a{color:red}")
    try:
        first = asset_url("/static/_version_probe.css")
        reset_cache()
        probe.write_text("a{color:red}")
        second = asset_url("/static/_version_probe.css")
    finally:
        probe.unlink()
    assert first == second


def test_a_missing_asset_falls_back_to_the_bare_path():
    """A wrong href should 404 on that one file, not 500 the whole page."""
    assert asset_url("/static/nope.css") == "/static/nope.css"


def test_offsite_urls_are_left_alone():
    assert asset_url("https://example.org/x.css") == "https://example.org/x.css"


# --- the pages --------------------------------------------------------------

@contextlib.contextmanager
def _client(tmp_path, monkeypatch, sign_in: bool):
    cfg = tmp_path / "event.yaml"
    shutil.copy(ROOT / "config" / "event.example.yaml", cfg)
    monkeypatch.setenv("EVENT_CONFIG", str(cfg))
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("TRACKER_PASSCODE", PASSCODE)
    monkeypatch.setenv("SESSION_SECRET", "0" * 64)
    db.close_connections()
    with TestClient(app) as c:
        if sign_in:
            assert c.post("/login", data={"passcode": PASSCODE},
                          follow_redirects=False).status_code == 303
        yield c
    db.close_connections()


@pytest.mark.parametrize(
    ("path", "sign_in"),
    [("/display", False), ("/login", False), ("/entry", True), ("/admin", True)],
)
def test_no_page_links_an_unversioned_asset(path, sign_in, tmp_path, monkeypatch):
    with _client(tmp_path, monkeypatch, sign_in) as c:
        body = c.get(path).text
    bare = re.findall(r'(?:href|src)="(/static/[^"?]+)"', body)
    assert not bare, f"{path} links {bare} without a cache-busting token"
    assert VERSIONED.search(body), f"{path} links no versioned asset at all"


def test_the_projector_page_versions_every_asset_it_loads(tmp_path, monkeypatch):
    """The display is the screen that stays open all evening unattended."""
    with _client(tmp_path, monkeypatch, sign_in=False) as c:
        body = c.get("/display").text
    assert len(VERSIONED.findall(body)) == 3  # norton.css, htmx, the sse ext


def test_a_versioned_url_still_serves_the_file(tmp_path, monkeypatch):
    """StaticFiles must ignore the query string, or every asset 404s."""
    with _client(tmp_path, monkeypatch, sign_in=False) as c:
        url = VERSIONED.search(c.get("/display").text).group(0)
        response = c.get(url)
    assert response.status_code == 200
    assert response.content == (STATIC_DIR / url.split("?")[0].split("/")[-1]).read_bytes()
