"""What exists twice during the port must stay identical.

Two things do: the aggregation SQL, and the declarative stat field lists.

`_DERIVED_STATS` in app/repository.py and `DERIVED_STATS` in shared/aggregate.ts
are the same query, because D1 is SQLite and phase 1 of ADR 0003 relocated it
rather than porting it. Relocating beats reimplementing, but it leaves two
copies, and the Python one is the one anybody debugging a prize will reach for.

So this compares them token for token, ignoring only whitespace. It fails on an
edit to either, which is the point: the fix is to make the same edit to the
other, and shared/schema.test.ts then proves the result still reproduces the
real night.

Deleted together with app/repository.py when phase 2 lands and the Worker is
the only thing running the query.
"""
import pathlib
import re

REPO = pathlib.Path(__file__).resolve().parents[1]


def _normalise(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


def _python_sql() -> tuple[str, str]:
    src = (REPO / "app" / "repository.py").read_text()
    seated = src.split('_SEATED_DAMAGE = """')[1].split('"""')[0]
    derived = src.split('_DERIVED_STATS = f"""')[1].split('"""')[0]
    return seated, derived.replace("{_SEATED_DAMAGE}", seated)


def _typescript_sql() -> tuple[str, str]:
    src = (REPO / "shared" / "aggregate.ts").read_text()
    seated = src.split("const SEATED_DAMAGE = `")[1].split("`;")[0]
    derived = src.split("export const DERIVED_STATS = `")[1].split("`;")[0]
    return seated, derived.replace("${SEATED_DAMAGE}", seated)


def test_the_seated_damage_filter_is_the_same_in_both():
    py, ts = _python_sql()[0], _typescript_sql()[0]
    assert _normalise(py) == _normalise(ts)


def test_the_derived_stats_query_is_the_same_in_both():
    py, ts = _python_sql()[1], _typescript_sql()[1]
    assert _normalise(py) == _normalise(ts)


# --- the stat field lists ---------------------------------------------------
#
# TURN_FIELDS and GAME_STAT_FIELDS describe what a form renders and what a
# sheet column is called, and `name` is load-bearing beyond the UI: it is the
# string an event's prize config refers to in `metric:`. A transcription slip
# between the two copies would show up as a prize that never awards, which is
# silent by design (an unknown metric reads as zero for everyone).


def _python_fields(const: str) -> list[tuple[str, str, str, str]]:
    src = (REPO / "app" / "models.py").read_text()
    block = src.split(f"{const}: tuple[StatField, ...] = (")[1].split("\n)")[0]
    return re.findall(r'StatField\("([a-z_]+)", "([^"]+)", "([^"]*)", "([^"]*)"\)', block)


def _typescript_fields(const: str) -> list[tuple[str, str, str, str]]:
    src = (REPO / "worker" / "fields.ts").read_text()
    block = src.split(f"export const {const}")[1].split("];")[0]
    return re.findall(
        r'name: "([a-z_]+)",\s*\n?\s*label: "([^"]+)",\s*\n?\s*hint: "([^"]*)",'
        r'\s*\n?\s*short: "([^"]*)"',
        block,
    )


def test_the_turn_fields_are_the_same_in_both():
    assert _python_fields("TURN_FIELDS") == _typescript_fields("TURN_FIELDS")


def test_the_game_stat_fields_are_the_same_in_both():
    assert _python_fields("GAME_STAT_FIELDS") == _typescript_fields("GAME_STAT_FIELDS")


def test_the_stat_cap_is_the_same_in_both():
    """Raised from 9999 to 99999 once already. A form that accepts more than
    the other would reject a turn the night actually produced."""
    py = (REPO / "app" / "models.py").read_text()
    ts = (REPO / "worker" / "fields.ts").read_text()
    assert re.search(r"^STAT_MAX = (\d+)", py, re.M).group(1) == (
        re.search(r"export const STAT_MAX = (\d+)", ts).group(1)
    )
    assert re.search(r"^COMMANDER_MAX = (\d+)", py, re.M).group(1) == (
        re.search(r"export const COMMANDER_MAX = (\d+)", ts).group(1)
    )


def test_both_copies_were_actually_found():
    """Guards the extraction above: a renamed constant would make both tests
    pass on empty strings."""
    for seated, derived in (_python_sql(), _typescript_sql()):
        assert "JOIN game_seats" in seated
        assert "biggest_attack_taken" in derived
        assert len(_normalise(derived)) > 1000
    # And the field lists: an empty list on both sides would compare equal.
    for const, count in (("TURN_FIELDS", 4), ("GAME_STAT_FIELDS", 8)):
        assert len(_python_fields(const)) == count
        assert len(_typescript_fields(const)) == count
