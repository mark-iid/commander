"""The captured entry rules must stay what app/routes/entry.py decides.

shared/fixtures/entry-rules.json is that module's own output over 61 cases, and
worker/entry-rules.test.ts requires the TypeScript port to give the same
answers. That only means something while the capture is current, so this guards
the link rather than the rules.

A failure means the Python rules changed. If that is intended,
`python3 scripts/entry_rules_fixture.py --write` adopts it, and the Worker's
test then fails until the port agrees again.
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from scripts.entry_rules_fixture import FIXTURE, build  # noqa: E402


def test_the_captured_rules_match_the_app():
    assert json.loads(FIXTURE.read_text()) == json.loads(json.dumps(build()))


def test_the_capture_covers_the_cases_that_matter():
    """Guards the capture. An empty case list would let the Worker's test pass
    against nothing, which is the failure mode of a golden fixture."""
    data = json.loads(FIXTURE.read_text())
    assert len(data["ordinals"]) >= 19
    assert len(data["finishing_orders"]) >= 10
    assert len(data["elimination_prompts"]) >= 9

    # The rules most likely to be got wrong have to be in there.
    ties = [
        c
        for c in data["finishing_orders"]
        if c["simultaneous"] and len(set(c["places"].values())) < len(c["places"])
    ]
    assert ties, "no simultaneous tie case: the better-placement rule is untested"

    teens = {c["n"] for c in data["ordinals"]} & {11, 12, 13}
    assert teens == {11, 12, 13}, "the th-suffix exceptions are untested"

    winner_excluded = [
        c for c in data["elimination_prompts"] if 1 in c["out"].values() and c["deaths_due"]
    ]
    assert winner_excluded, "no case where the winner must not count as a death"
