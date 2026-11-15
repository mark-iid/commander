"""Rendering on a phone, and the type scale on the projected board.

Two things get pinned here that nothing else covers.

The first is the viewport meta tag. Without it a phone lays the page out at
980px and scales the result down, so every media query below misses and the
whole site renders as a shrunken desktop. It is one line per page shell and
completely silent when absent, which is exactly the kind of thing that gets
dropped by a template refactor.

The second is where the standings font-size lives. `em` in a table cell
resolves against the cell's parent, so putting the row size on the cells rather
than the table left `.dmg { font-size: .6em }` meaning 60% of the *root* — the
damage column rendered at 12px next to a 50px player name. The rules below
assert the chain that makes an em mean what it reads as, because the failure is
silent: the CSS stays valid and the board just quietly gets a column nobody in
the room can read.
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
from app.main import app  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
STATIC = ROOT / "app" / "static"
TEMPLATES = ROOT / "app" / "templates"
PASSCODE = "test-passcode"

NORTON = (STATIC / "norton.css").read_text()
APP_CSS = (STATIC / "app.css").read_text()


def _blocks(css: str, selector: str) -> list[str]:
    """Declaration bodies of every rule written with exactly this selector."""
    found = re.findall(re.escape(selector) + r"\s*\{([^{}]*)\}", css)
    assert found, f"no rule for {selector!r}"
    return found


# --- viewport ---------------------------------------------------------------

def _page_shells() -> list[pathlib.Path]:
    """Templates that emit a whole document, so they own the <head>."""
    return sorted(
        p for p in TEMPLATES.rglob("*.html")
        if "<!doctype" in p.read_text().lower()
    )


def test_there_is_more_than_one_page_shell_to_check():
    """Guards the guard: a glob that matched nothing would pass silently."""
    shells = {p.name for p in _page_shells()}
    assert shells == {"base.html", "index.html"}


@pytest.mark.parametrize("shell", _page_shells(), ids=lambda p: str(p.relative_to(TEMPLATES)))
def test_every_page_shell_sets_the_viewport(shell):
    assert 'name="viewport"' in shell.read_text()
    assert "width=device-width" in shell.read_text()


# --- the standings em chain -------------------------------------------------

def test_the_row_size_is_set_on_the_table_not_the_cells():
    """The em chain starts here. If this moves back onto the cells, every em
    below it silently starts resolving against the root instead of the row."""
    assert "font-size" in _blocks(NORTON, ".standings")[0]


def test_cells_inherit_the_row_size():
    cells = _blocks(NORTON, ".standings td, .standings th")[0]
    size = re.search(r"font-size:\s*([^;]+);", cells)
    assert size and size.group(1).strip() == "inherit"


@pytest.mark.parametrize("selector", [".standings .dmg", ".standings thead th"])
def test_secondary_columns_are_sized_relative_to_the_row(selector):
    """rem or px here would be the original bug: type that stays put while the
    roster grows and the rows shrink around it."""
    sizes = [
        m.group(1).strip()
        for block in _blocks(NORTON, selector)
        for m in [re.search(r"font-size:\s*([^;]+);", block)]
        if m
    ]
    assert sizes, f"{selector} sets no font-size"
    for size in sizes:
        assert re.fullmatch(r"[0-9.]+em", size), f"{selector} is {size}, not an em of the row"


def test_the_damage_heading_is_not_outranked_by_the_column_rule():
    """`.standings thead th` is (0,1,2) and `.standings .dmg` is (0,2,0), and
    class count is compared before element count -- so the column rule wins and
    the Dmg heading renders a size larger than the headings beside it. Measured
    in a browser, not deduced; the CSS is valid either way."""
    assert re.search(r"\.standings thead th\.dmg\s*\{[^{}]*font-size", NORTON)


def test_the_damage_column_is_not_a_whisper():
    """It is the tiebreaker, so it sits below the player name — but the
    complaint that started this was that it was unreadable across a room."""
    dmg = next(
        m.group(1) for block in _blocks(NORTON, ".standings .dmg")
        for m in [re.search(r"font-size:\s*([0-9.]+)em;", block)] if m
    )
    assert 0.65 <= float(dmg) <= 0.85


def test_the_height_budget_counts_the_header_row():
    """The table is header + rows; budgeting only for rows overflows a board
    that cannot scroll."""
    size = _blocks(NORTON, ".standings")[0]
    assert re.search(r"var\(--rows,\s*4\)\s*\*\s*[0-9.]+\s*\+\s*[0-9.]+", size)


# --- mobile -----------------------------------------------------------------

def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def test_the_phone_block_comes_after_the_rules_it_overrides():
    """A media query adds no specificity, so an override wins only by coming
    later in the file. Placed above .standings, the phone rules parse fine,
    apply nothing, and look correct in review — which is exactly what happened.
    """
    start = NORTON.index("@media (max-width: 900px)")
    base, mobile = NORTON[:start], NORTON[start:]
    body = mobile[mobile.index("{") + 1: mobile.rindex("}")]
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
    selectors = [_norm(s) for s in re.findall(r"([^{}]+)\{", body)]

    assert len(selectors) >= 5, f"only found {selectors} in the phone block"
    base_norm = _norm(base)
    for selector in selectors:
        assert re.search(re.escape(selector) + r"\s*\{", base_norm), (
            f"{selector!r} is overridden for phones but defined after the media "
            "query, so the override never applies"
        )


def test_the_display_drops_its_projector_gutters_on_a_phone():
    """80px each side leaves 200px of a 360px screen for the status bar."""
    mobile = NORTON.split("@media (max-width: 900px)")[1]
    assert re.search(r"#foot\s*\{[^{}]*padding:[^;]*24px", mobile)


def test_the_display_pins_a_readable_base_size_on_a_phone():
    """The projector formula is mostly vh and bottoms out on the 11px floor on
    a handset, which renders the whole board as fine print."""
    mobile = NORTON.split("@media (max-width: 900px)")[1]
    assert re.search(r"html\s*\{[^{}]*font-size:\s*\d+px", mobile)


def test_the_roster_stacks_instead_of_scrolling_sideways():
    mobile = APP_CSS.split("@media (max-width: 34rem)")[1]
    assert ".roster-table thead { display: none; }" in mobile
    assert "attr(data-label)" in mobile


# --- the markup the stacked layout depends on -------------------------------

@contextlib.contextmanager
def _client(tmp_path, monkeypatch):
    cfg = tmp_path / "event.yaml"
    shutil.copy(ROOT / "config" / "event.example.yaml", cfg)
    monkeypatch.setenv("EVENT_CONFIG", str(cfg))
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("TRACKER_PASSCODE", PASSCODE)
    monkeypatch.setenv("SESSION_SECRET", "0" * 64)
    db.close_connections()
    with TestClient(app) as c:
        assert c.post("/login", data={"passcode": PASSCODE},
                      follow_redirects=False).status_code == 303
        yield c
    db.close_connections()


def test_roster_cells_carry_their_column_heading(tmp_path, monkeypatch):
    """<thead> is hidden when the rows stack, so the headings have to travel
    with the cells or the phone layout loses them entirely."""
    with _client(tmp_path, monkeypatch) as c:
        body = c.get("/admin").text
    assert 'class="roster-table"' in body
    assert 'data-label="Name"' in body
    assert 'data-label="Commander"' in body
    assert 'class="row-actions"' in body
