"""Public display surface: board rendering and the SSE push.

The board's numbers come from the already-verified scoring engine, so these
tests focus on what the display layer itself owns — that saves reach the screen,
that the SSE payload is the real board partial, and that an empty event renders.
"""
import pathlib
import shutil
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import db  # noqa: E402
from app.config import load_scoring  # noqa: E402
from app.main import app  # noqa: E402
from app.scoring import leaderboard  # noqa: E402
from tests.helpers import record_final, record_stat, record_turn, seat_table  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
ROSTER = ["Alice", "Bob", "Carol", "Dave"]


def _seed(client, player, placement, pod="A", rnd=1, **kw):
    """One finished game for one player. `rnd` is the match number."""
    # total_graveyard replaced peak_graveyard when the graveyard became a count
    # taken at death rather than a running maximum.
    kw.setdefault("total_graveyard", kw.pop("peak_graveyard", 0))
    return record_stat(client, player, placement, pod=pod, match=rnd, **kw)


PASSCODE = "test-passcode"


def _env(tmp_path, monkeypatch, db_name):
    cfg = tmp_path / "event.yaml"
    shutil.copy(ROOT / "config" / "event.example.yaml", cfg)
    monkeypatch.setenv("EVENT_CONFIG", str(cfg))
    monkeypatch.setenv("DB_PATH", str(tmp_path / db_name))
    monkeypatch.setenv("TRACKER_PASSCODE", PASSCODE)
    monkeypatch.setenv("SESSION_SECRET", "0" * 64)
    db.close_connections()


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Signed in, because seeding the board goes through the guarded /entry.
    /display itself is open by default — that is asserted in tests/test_auth.py."""
    _env(tmp_path, monkeypatch, "test.db")
    with TestClient(app) as c:
        assert c.post("/login", data={"passcode": PASSCODE},
                      follow_redirects=False).status_code == 303
        yield c
    db.close_connections()


def test_empty_event_renders_all_prizes_unclaimed(client):
    r = client.get("/display")
    assert r.status_code == 200
    body = r.text
    assert body.count("unclaimed") == 11        # every configured prize
    assert "0 of 11 claimed" in body
    # roster present but nobody has played
    for name in ("Alice", "Bob", "Carol", "Dave"):
        assert name in body
    assert 'class="idle"' in body
    assert 'class="leader"' not in body        # no leader before any game


def test_board_reflects_a_saved_entry(client):
    _seed(client, "Bob", 1, combat_dmg_dealt=40, peak_graveyard=30)
    body = client.get("/display").text
    assert 'class="leader"' in body
    # Bob took 1st: 4 win points, and leads the damage-based prizes
    assert "Does Nobody Block?" in body
    assert "1 game" in body


def test_leader_is_the_top_of_the_standings(client):
    _seed(client, "Dave", 1)     # 4 pts
    _seed(client, "Alice", 4)    # 1 pt
    body = client.get("/display").text
    leader_row = body[body.index('class="leader"'):]
    # the leader row's name cell comes before any other player's
    assert leader_row.index("Dave") < leader_row.index("Alice")


def _winners() -> dict[str, str | None]:
    storage = db.get_storage()
    event_id = app.state.event_id
    results = leaderboard(storage.all_stats(event_id), load_scoring(), storage.roster(event_id))
    return {r.key: r.winner for r in results}


def test_seating_a_table_claims_no_prize(client):
    """A seated table has not played. The min prizes used to go to the first
    seated name on the roster, at 0, the moment the table was set: nobody had
    dealt commander damage because nobody had taken a turn."""
    seat_table(client, names=["Carol", "Alice", "Dave", "Bob"])
    body = client.get("/display").text
    assert "0 of 11 claimed" in body
    assert 'class="leader"' not in body


def test_a_player_contends_once_they_have_taken_a_turn(client):
    seat_table(client, names=["Carol", "Alice", "Dave", "Bob"])
    assert record_turn(client, "Carol").status_code == 200

    winners = _winners()
    assert winners["forty_more_than_twenty_one"] == "Carol"
    assert winners["blame_it_on_shuffling"] == "Carol"


def test_being_attacked_counts_as_playing(client):
    """Bob is hit before his own first turn. He is in the game, and the hit is
    his: You Should See the Other Guy must not wait for his turn to be saved."""
    seat_table(client, names=["Carol", "Alice", "Dave", "Bob"])
    # Carol's opponents in seat order are Alice, Dave, Bob, so Bob is cell 3.
    assert record_turn(client, "Carol", damage={3: 9}).status_code == 200

    assert _winners()["you_should_see_the_other_guy"] == "Bob"


def test_a_player_out_before_their_first_turn_still_scores(client):
    """Drained out from the far seat before their turn came round: no turn, no
    combat hit, only a death/win row. Fourth place is still a point."""
    seat_table(client, names=["Carol", "Alice", "Dave", "Bob"])
    assert record_final(client, "Bob", 4).status_code == 200

    assert _winners()["technical_winner"] == "Bob"


def test_display_is_standalone_and_norton_themed(client):
    body = client.get("/display").text
    assert "/static/norton.css" in body
    assert "/static/app.css" not in body        # does not inherit the entry theme
    assert 'sse-connect="/display/stream"' in body
    assert "/static/htmx-ext-sse.js" in body


# --- SSE ---------------------------------------------------------------------
#
# These run against a real uvicorn server rather than TestClient. An SSE
# response never completes, and TestClient's portal blocks on teardown waiting
# for the generator to finish, which hangs the suite. A live server also
# exercises the actual ASGI disconnect path, which is the part that matters.

import contextlib  # noqa: E402
import socket  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import urllib.parse  # noqa: E402
import urllib.request  # noqa: E402
from http.cookiejar import CookieJar  # noqa: E402


def _authed(base: str):
    """An opener holding a signed-in session cookie.

    /display and its stream are public, but seeding the board goes through the
    guarded /entry, so the live tests need a real login.
    """
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    payload = urllib.parse.urlencode({"passcode": PASSCODE}).encode()
    opener.open(urllib.request.Request(f"{base}/login", data=payload), timeout=10).close()
    return opener


def _post(opener, base: str, path: str, pairs) -> None:
    payload = urllib.parse.urlencode(pairs, doseq=True).encode()
    with opener.open(urllib.request.Request(f"{base}{path}", data=payload), timeout=10) as r:
        assert r.status == 200


def _save(opener, base: str, *, player, placement, pod="A", rnd=1, **stat):
    """Seat the table, record a turn, then finish the player.

    Three requests where there used to be one: the turn tables need a seated
    table to attach to, and a placement is only accepted once the player is out.
    """
    _post(opener, base, "/entry/seat",
          [("pod", pod), ("match_no", str(rnd))] + [("seat", n) for n in ROSTER])
    _post(opener, base, "/entry/turn", {
        "pod": pod, "match_no": str(rnd), "player": player, "round_no": "1",
        "attacking_creatures": "0", "cmdr_dmg_dealt": "0",
        "noncombat_dmg_dealt": "0", "opps_eliminated": "0",
        "dmg_1": str(stat.get("combat_dmg_dealt", 0)),
    })
    _post(opener, base, "/entry/final", {
        "pod": pod, "match_no": str(rnd), "player": player, "round_no": "1",
        "placement": str(placement), "final_life": "0",
        "total_graveyard": str(stat.get("total_graveyard", 0)),
    })


@pytest.fixture
def live_url(tmp_path, monkeypatch):
    import uvicorn

    _env(tmp_path, monkeypatch, "live.db")

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]

    server = uvicorn.Server(uvicorn.Config(app, log_level="error"))
    thread = threading.Thread(target=lambda: server.run(sockets=[sock]), daemon=True)
    thread.start()

    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    assert server.started, "uvicorn did not start"

    yield base

    server.should_exit = True
    thread.join(timeout=10)
    db.close_connections()


def _read_event(resp, timeout: float = 10.0) -> str:
    """Read one complete `leaderboard` SSE event.

    An SSE event is terminated by a blank line; reading until a substring
    appears would truncate mid-frame. Ping comments are skipped.
    """
    deadline = time.time() + timeout
    buf = ""
    while time.time() < deadline:
        line = resp.readline()
        if not line:
            break
        text = line.decode()
        if text in ("\r\n", "\n"):
            if "event: leaderboard" in buf:
                return buf
            buf = ""            # ping or other event; discard and keep reading
            continue
        buf += text
    raise AssertionError(f"no leaderboard event within {timeout}s; partial:\n{buf[:1500]}")


def test_stream_sends_the_board_immediately_on_connect(live_url):
    """A projector connecting mid-event must be correct at once, not blank
    until the next save."""
    with contextlib.closing(urllib.request.urlopen(f"{live_url}/display/stream", timeout=10)) as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        frame = _read_event(r)
        assert "event: leaderboard" in frame
        assert 'id="board"' in frame
        assert "Standings" in frame


def test_saving_pushes_an_updated_board(live_url):
    """The contract of build step 4: a tracker saves and the projector receives
    a re-rendered board, with no polling."""
    with contextlib.closing(urllib.request.urlopen(f"{live_url}/display/stream", timeout=10)) as r:
        first = _read_event(r)
        assert 'class="leader"' not in first          # nobody has played yet

        _save(_authed(live_url), live_url, player="Carol", placement=1, combat_dmg_dealt=25)

        pushed = _read_event(r)
        assert "event: leaderboard" in pushed
        assert "Carol" in pushed


def test_stream_survives_a_disconnected_client(live_url):
    """A projector that drops off must not wedge the stream for the next one."""
    r = urllib.request.urlopen(f"{live_url}/display/stream", timeout=10)
    _read_event(r)
    r.close()  # projector unplugged

    _save(_authed(live_url), live_url, player="Bob", placement=1)

    # a fresh connection still gets a correct board
    with contextlib.closing(urllib.request.urlopen(f"{live_url}/display/stream", timeout=10)) as r2:
        frame = _read_event(r2)
        assert "Bob" in frame


# --- the board must fit the roster it is given ---------------------------------
#
# The projected board cannot scroll (body is overflow:hidden), so row height has
# to fall out of the row count. With a fixed size a 16-player roster -- four
# tables, which is a configuration this event actually runs -- pushed the last
# players off the bottom of the screen with nothing on the page to say so.

def _roster_client(tmp_path, monkeypatch, roster):
    """A client whose event was seeded with an arbitrary roster size."""
    cfg = tmp_path / "event.yaml"
    text = (ROOT / "config" / "event.example.yaml").read_text()
    listing = "\n".join(f"  - {n}" for n in roster)
    text = text.replace("roster:\n  - Alice\n  - Bob\n  - Carol\n  - Dave",
                        "roster:\n" + listing if roster else "roster: []")
    cfg.write_text(text)
    monkeypatch.setenv("EVENT_CONFIG", str(cfg))
    monkeypatch.setenv("DB_PATH", str(tmp_path / "rows.db"))
    monkeypatch.setenv("TRACKER_PASSCODE", PASSCODE)
    monkeypatch.setenv("SESSION_SECRET", "0" * 64)
    db.close_connections()
    return TestClient(app)


@pytest.mark.parametrize("count", [1, 4, 8, 16])
def test_standings_publishes_its_row_count_to_css(tmp_path, monkeypatch, count):
    with _roster_client(tmp_path, monkeypatch, [f"P{i}" for i in range(count)]) as c:
        assert f"--rows: {count}" in c.get("/display").text


def test_an_empty_roster_does_not_emit_a_zero_row_count(tmp_path, monkeypatch):
    """calc(... / 0) is invalid CSS and would drop the font-size declaration."""
    with _roster_client(tmp_path, monkeypatch, []) as c:
        body = c.get("/display").text
        assert "--rows: 0" not in body
        assert "--rows: 1" in body
