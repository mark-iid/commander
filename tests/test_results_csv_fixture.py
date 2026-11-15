"""The captured CSV exports must stay what the Python app actually produces.

shared/fixtures/fall-2026-results.csv and -turns.csv are the FastAPI app's own
output over the golden fixture, and worker/routes/results.test.ts requires the
Worker to reproduce them byte for byte. That only means something while they
are still Python's output, so this guards the link rather than the exports.

A failure here means the Python exports changed. That may be right, in which
case `python3 scripts/results_csv_fixture.py --write` adopts it and the
Worker's test then fails until the TypeScript side agrees again.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from scripts.results_csv_fixture import EXPORTS, recapture  # noqa: E402


def test_the_captured_exports_match_the_app():
    fresh = recapture()
    for kind, path in EXPORTS.items():
        # newline="" so the CRLF the exports carry is not translated away on
        # the way in. A plain read_text() compares LF against CRLF and reports
        # a stale fixture that is nothing of the kind.
        assert path.read_text(newline="") == fresh[kind], f"{path.name} is stale"


def test_the_exports_are_a_whole_night_and_carry_the_awkward_cases():
    """Guards the captures themselves. A truncated file would let the Worker's
    byte comparison pass against nothing."""
    results = EXPORTS["results"].read_bytes()
    turns = EXPORTS["turns"].read_bytes()

    # Header plus one row per player per game, and per turn.
    assert len(results.splitlines()) == 25
    assert len(turns.splitlines()) == 157

    # CRLF, which is what csv.writer emits and what a spreadsheet expects.
    assert b"\r\n" in results and b"\r\n" in turns

    # A deck name with a comma in it, quoted. This is the case a hand-rolled
    # CSV writer gets wrong, and getting it wrong shifts every later column.
    assert b'"Omnath, Locus of All"' in results

    # The turns export distinguishes "not at this table" (blank) from "at the
    # table and took nothing" (0). A single zero for both would lose that.
    assert b",,,," in turns
