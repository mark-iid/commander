"""The golden fixture must stay what the app actually computes.

shared/fixtures/fall-2026.json carries the real Fall 2026 night and the results
app/scoring.py produced from it. The TypeScript port is held to those results
(shared/scoring.golden.test.ts), which is only meaningful while they are still
Python's output -- so this guards the link rather than the engine.

A failure here means the Python side changed. That may be entirely correct, in
which case `python3 scripts/fixture_expected.py --write` adopts the new results
and the TypeScript golden test then fails until that engine is brought along.
What cannot happen is the two drifting apart with both suites green.
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from scripts.fixture_expected import FIXTURE, recompute  # noqa: E402


def _fixture() -> dict:
    return json.loads(FIXTURE.read_text())


def test_the_fixture_matches_what_the_app_computes():
    fixture = _fixture()
    fresh = recompute(fixture)
    assert fresh["derived"] == fixture["derived"]
    assert fresh["expected"] == fixture["expected"]


def test_the_fixture_is_a_whole_night_and_not_a_stub():
    """A truncated file would let the TypeScript golden test pass against
    nothing, which is the failure mode of a golden test nobody notices."""
    fixture = _fixture()
    assert len(fixture["roster"]) == 8
    assert len(fixture["raw"]["games"]) == 6
    assert len(fixture["raw"]["turn_stats"]) == 156
    assert len(fixture["derived"]) == 24
    assert len(fixture["expected"]["prizes"]) == 11
    assert all(p["winner"] is not None for p in fixture["expected"]["prizes"])


def test_the_fixture_carries_no_real_names():
    """The night was played by real people. The committed copy is pseudonymous,
    in the original roster order because roster order breaks a surviving tie."""
    fixture = _fixture()
    assert fixture["roster"] == ["Alice", "Bob", "Carol", "Dave", "Erin", "Frank", "Grace", "Heidi"]
    assert [p["name"] for p in sorted(fixture["raw"]["players"], key=lambda p: p["player_id"])] == (
        fixture["roster"]
    )
    assert fixture["scoring"]["prize_ineligible"] == ["Alice"]
