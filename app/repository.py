"""Storage layer. The ONLY place SQL lives.

`Storage` is a Protocol; `SQLiteStorage` implements it. A future `PostgresStorage`
can implement the same Protocol and be swapped in via app/db wiring — no caller
changes. Methods below are the minimum the app needs; flesh out as routes land.
"""
from __future__ import annotations

import sqlite3
from typing import Protocol

from app.models import FinalStat, Game, Player, RecordedTurn, TurnStat
from app.scoring import GamePlayerStat

# The widest integer SQLite can bind. Lives here, not in a route: it is a fact about
# the storage backend, and a route that knew it would be a backend leak (ADR 0001).
SQLITE_INT_MAX = 2**63 - 1
SQLITE_INT_MIN = -(2**63)


class ValueTooWideForStorage(Exception):
    """A numeric value the backend cannot store.

    Raised in place of the driver's OverflowError so callers never import sqlite3.
    This is the last line of defence: routes bound their own input first (see
    models.STAT_MAX). Without it an over-wide value raised out of add_stat *before*
    the INSERT, so the row was silently never written — the tracker saw no error
    because htmx does not swap 5xx, only a panel that failed to update (KG-10).
    """

    def __init__(self, field: str, value: int):
        super().__init__(f"{field}={value} is too wide to store")
        self.field = field
        self.value = value


class DuplicatePlayerName(Exception):
    """A player with that name already exists in the event.

    Raised in place of the driver's integrity error so callers never have to
    import sqlite3 — that dependency staying inside this module is what keeps
    a PostgresStorage swap a config change (ADR 0001).
    """

    def __init__(self, name: str):
        super().__init__(f"duplicate player name {name!r}")
        self.name = name


class Storage(Protocol):
    # events / roster
    def ensure_event(self, name: str, games_per_player: int) -> tuple[int, bool]: ...
    def sync_roster(self, event_id: int, names: list[str]) -> None: ...
    def roster(self, event_id: int) -> list[str]: ...

    # players (admin)
    def players(self, event_id: int) -> list[Player]: ...
    def get_player(self, event_id: int, player_id: int) -> Player | None: ...
    def add_player(self, event_id: int, name: str, commander: str | None) -> int: ...
    def update_player(
        self, event_id: int, player_id: int, name: str, commander: str | None
    ) -> None: ...
    def delete_player(self, event_id: int, player_id: int) -> bool: ...
    def player_has_stats(self, player_id: int) -> bool: ...

    # reset (scripts/reset.py, /admin danger zone)
    def count_results(self, event_id: int) -> tuple[int, int]: ...
    def clear_results(self, event_id: int) -> tuple[int, int]: ...
    def clear_roster(self, event_id: int) -> int: ...

    # games
    def find_game(self, event_id: int, pod: str, match_no: int) -> int | None: ...
    def get_or_create_game(self, event_id: int, pod: str, match_no: int) -> int: ...
    def games(self, event_id: int) -> list[Game]: ...

    # seating (who is at which table for this match)
    def seat_players(self, game_id: int, names: list[str]) -> None: ...
    def seating(self, game_id: int) -> list[str]: ...
    def seated_elsewhere(
        self, event_id: int, match_no: int, exclude_game: int | None
    ) -> set[str]: ...

    # commanders (which deck a player brought to a match)
    def commanders_for_match(self, event_id: int, match_no: int) -> dict[str, str]: ...
    def set_match_commanders(
        self, event_id: int, match_no: int, by_player: dict[str, str]
    ) -> None: ...
    def all_match_commanders(self, event_id: int) -> dict[tuple[str, int], str]: ...

    # turns
    def save_turn(self, game_id: int, player: str, turn: TurnStat) -> None: ...
    def turn_for(self, game_id: int, player: str, round_no: int) -> TurnStat | None: ...
    def turn_grid(self, game_id: int) -> dict[tuple[str, int], TurnStat]: ...
    def rounds_played(self, game_id: int) -> int: ...
    def all_turns(self, event_id: int) -> list[RecordedTurn]: ...
    def damage_matrix(self, event_id: int) -> dict[int, dict[tuple[str, str], int]]: ...

    # the death/win section
    def save_final(self, game_id: int, player: str, final: FinalStat) -> None: ...
    def save_finals(self, game_id: int, by_player: dict[str, FinalStat]) -> None: ...
    def final_for(self, game_id: int, player: str) -> FinalStat | None: ...

    # derived per-game stats, assembled from the turn tables for scoring
    def stats_for_game(self, game_id: int) -> list[GamePlayerStat]: ...
    def stat_for(self, game_id: int, player: str) -> GamePlayerStat | None: ...
    def all_stats(self, event_id: int) -> list[GamePlayerStat]: ...


# Combat damage between two players who are both seated at that game now. A
# reseat leaves turns where they were (see seat_players), so a hit recorded
# against somebody since moved to the other pod would otherwise still score
# for the dealer and still count as taken. Every read of turn_damage that
# feeds a total goes through this.
_SEATED_DAMAGE = """
    SELECT d.game_id, d.player_id, d.round_no, d.target_id, d.combat_dmg
    FROM turn_damage d
    JOIN game_seats sd ON sd.game_id = d.game_id AND sd.player_id = d.player_id
    JOIN game_seats st ON st.game_id = d.game_id AND st.player_id = d.target_id
"""

_DERIVED_STATS = f"""
WITH seated_damage AS ({_SEATED_DAMAGE}),
per_round AS (
    SELECT game_id, player_id, round_no, SUM(combat_dmg) AS round_combat
    FROM seated_damage GROUP BY game_id, player_id, round_no
),
dealt AS (
    SELECT game_id, player_id,
           SUM(round_combat) AS total_combat,
           MAX(round_combat) AS biggest_dealt
    FROM per_round GROUP BY game_id, player_id
),
taken AS (
    SELECT game_id, target_id AS player_id,
           SUM(combat_dmg) AS total_taken,
           MAX(combat_dmg) AS biggest_taken
    FROM seated_damage GROUP BY game_id, target_id
),
turns AS (
    SELECT game_id, player_id,
           SUM(cmdr_dmg_dealt)      AS cmdr,
           SUM(noncombat_dmg_dealt) AS noncombat,
           SUM(opps_eliminated)     AS elims,
           MAX(attacking_creatures) AS creatures,
           SUM(attacking_creatures) AS creatures_total
    FROM turn_stats GROUP BY game_id, player_id
)
SELECT
    seats.game_id                     AS game_id,
    p.name                            AS player,
    f.placement                       AS placement,
    COALESCE(f.final_life, 0)         AS final_life,
    COALESCE(d.total_combat, 0)       AS combat_dmg_dealt,
    COALESCE(t.noncombat, 0)          AS noncombat_dmg_dealt,
    COALESCE(t.cmdr, 0)               AS cmdr_dmg_dealt,
    COALESCE(t.elims, 0)              AS opps_eliminated,
    COALESCE(d.biggest_dealt, 0)      AS biggest_attack_dealt,
    COALESCE(k.biggest_taken, 0)      AS biggest_attack_taken,
    COALESCE(t.creatures, 0)          AS most_creatures_in_attack,
    COALESCE(f.total_graveyard, 0)    AS total_graveyard,
    COALESCE(k.total_taken, 0)        AS combat_dmg_taken,
    COALESCE(t.creatures_total, 0)    AS creatures_attacked_with,
    (t.player_id IS NOT NULL OR k.player_id IS NOT NULL OR f.player_id IS NOT NULL)
                                      AS played
FROM game_seats seats
JOIN players p ON p.player_id = seats.player_id
JOIN games gm ON gm.game_id = seats.game_id
LEFT JOIN game_player_stats f ON f.game_id = seats.game_id AND f.player_id = seats.player_id
LEFT JOIN dealt d ON d.game_id = seats.game_id AND d.player_id = seats.player_id
LEFT JOIN taken k ON k.game_id = seats.game_id AND k.player_id = seats.player_id
LEFT JOIN turns t ON t.game_id = seats.game_id AND t.player_id = seats.player_id
"""
"""Rebuild the per-game scalars app/scoring.py consumes from the turn tables.

The storage granularity is per-turn; the scoring engine's is per-game. This
query is the whole of the translation between them, which is why scoring.py did
not change when the granularity did:

  totals  SUM over a player's turns  (combat dealt and taken, commander,
          non-combat, elims, creatures attacked with)
  peaks   MAX over a player's turns  (biggest attack dealt/taken, creatures)
  final   joined straight from game_player_stats (placement, life, graveyard)

"biggest attack dealt" is a turn's combat damage summed across every opponent,
because one declared attack in Commander can hit several players at once.
"biggest attack taken" is a single turn_damage row: each row is already one
dealer hitting one target in one turn, which is exactly one attack.

Driven from game_seats, not from game_player_stats, so a seated player who has
not acted yet still appears -- with zeros and a NULL placement rather than
missing from the standings entirely.

`played` says whether anything is recorded for them yet: a turn of their own,
a hit taken, or the death/win row. A hit counts because the player is in the
game whether or not their own turn has come round, and the hit is theirs for
"biggest attack taken". Scoring skips rows where it is false.
"""


def _game_player_stat(row: sqlite3.Row) -> GamePlayerStat:
    """SQLite has no boolean type: `played` comes back as 0 or 1."""
    return GamePlayerStat(**{**dict(row), "played": bool(row["played"])})


# Everything deleting a player would cascade away. One definition serves both
# the operator-facing pre-check and the guard inside the DELETE, because they
# drifted once: when turns moved out of game_player_stats, only the pre-check
# learned about them, and the guard waved through a player mid-game.
_PLAYER_IN_A_GAME = """
       EXISTS (SELECT 1 FROM game_seats        WHERE player_id = :p)
    OR EXISTS (SELECT 1 FROM turn_stats        WHERE player_id = :p)
    OR EXISTS (SELECT 1 FROM turn_damage       WHERE player_id = :p OR target_id = :p)
    OR EXISTS (SELECT 1 FROM game_player_stats WHERE player_id = :p)
"""


class SQLiteStorage:
    def __init__(self, conn: sqlite3.Connection):
        self._conn = conn

    # --- events / roster ---------------------------------------------------

    def ensure_event(self, name: str, games_per_player: int) -> tuple[int, bool]:
        """Idempotent by name. Renaming the event in config starts a new one —
        existing games stay attached to the old row.

        Returns (event_id, created). `created` is what makes "config seeds the
        roster once" literally true: an empty roster is not the same thing as a
        brand-new event once admin can delete players.
        """
        cur = self._conn.execute("SELECT event_id FROM events WHERE name = ?", (name,))
        row = cur.fetchone()
        if row is not None:
            return int(row["event_id"]), False
        cur = self._conn.execute(
            "INSERT INTO events (name, games_per_player) VALUES (?, ?)",
            (name, games_per_player),
        )
        self._conn.commit()
        return int(cur.lastrowid), True

    def sync_roster(self, event_id: int, names: list[str]) -> None:
        """Insert-only. Never deletes: dropping a player would cascade away their
        recorded stats, so removals stay a deliberate admin action."""
        self._conn.executemany(
            "INSERT OR IGNORE INTO players (event_id, name) VALUES (?, ?)",
            [(event_id, n) for n in names],
        )
        self._conn.commit()

    def roster(self, event_id: int) -> list[str]:
        cur = self._conn.execute(
            "SELECT name FROM players WHERE event_id = ? ORDER BY player_id", (event_id,)
        )
        return [r["name"] for r in cur.fetchall()]

    # --- players (admin) ---------------------------------------------------

    def players(self, event_id: int) -> list[Player]:
        """Same ORDER BY as roster(): player_id order is the deterministic
        tiebreaker app/scoring.py relies on, so both views must agree."""
        cur = self._conn.execute(
            """
            SELECT player_id, name, commander
            FROM players WHERE event_id = ? ORDER BY player_id
            """,
            (event_id,),
        )
        return [
            Player(int(r["player_id"]), r["name"], r["commander"]) for r in cur.fetchall()
        ]

    def get_player(self, event_id: int, player_id: int) -> Player | None:
        """Scoped by event: a hand-crafted form must not reach another event's
        players."""
        cur = self._conn.execute(
            """
            SELECT player_id, name, commander
            FROM players WHERE event_id = ? AND player_id = ?
            """,
            (event_id, player_id),
        )
        row = cur.fetchone()
        if row is None:
            return None
        return Player(int(row["player_id"]), row["name"], row["commander"])

    def _name_taken(self, event_id: int, name: str) -> bool:
        cur = self._conn.execute(
            "SELECT 1 FROM players WHERE event_id = ? AND name = ? LIMIT 1",
            (event_id, name),
        )
        return cur.fetchone() is not None

    def _translate_integrity_error(
        self, event_id: int, name: str, exc: sqlite3.IntegrityError
    ) -> DuplicatePlayerName:
        """Only a genuine name collision becomes DuplicatePlayerName.

        Asking the database whether the name exists is deterministic and
        driver-agnostic; matching on the exception's message text would bind us
        to SQLite's wording and would report an unrelated NOT NULL or CHECK
        failure to the operator as a duplicate name.
        """
        self._conn.rollback()
        if self._name_taken(event_id, name):
            return DuplicatePlayerName(name)
        raise exc

    def add_player(self, event_id: int, name: str, commander: str | None) -> int:
        try:
            cur = self._conn.execute(
                "INSERT INTO players (event_id, name, commander) VALUES (?, ?, ?)",
                (event_id, name, commander),
            )
        except sqlite3.IntegrityError as exc:
            raise self._translate_integrity_error(event_id, name, exc) from exc
        self._conn.commit()
        return int(cur.lastrowid)

    def update_player(
        self, event_id: int, player_id: int, name: str, commander: str | None
    ) -> None:
        """Renaming is safe: stats key on player_id, not name."""
        try:
            self._conn.execute(
                """
                UPDATE players SET name = ?, commander = ?
                WHERE player_id = ? AND event_id = ?
                """,
                (name, commander, player_id, event_id),
            )
        except sqlite3.IntegrityError as exc:
            raise self._translate_integrity_error(event_id, name, exc) from exc
        self._conn.commit()

    def delete_player(self, event_id: int, player_id: int) -> bool:
        """Refuses, in one statement, to delete a player who is part of a game:
        seated at a table, with a turn, hit by someone else's turn, or with a
        death/win row. Each of those cascades away with the player, and a hit
        taken is another player's combat damage.

        The guard has to live in the same statement as the delete. A separate
        player_has_stats() check is a time-of-check/time-of-use race: a tracker
        saving that player's first stat row in the window between the two
        statements would have their game silently cascaded away, and the only
        thing standing in the way today is that no `await` happens to sit
        between them on a single-worker event loop. That is scheduling luck,
        not an invariant.

        Returns True if a row was deleted, False if the player does not exist in
        this event or has stats. Callers may still pre-check player_has_stats()
        to tell the operator *why*, but this return value is the authority.
        """
        cur = self._conn.execute(
            f"""
            DELETE FROM players
            WHERE player_id = :p AND event_id = :e
              AND NOT ({_PLAYER_IN_A_GAME})
            """,
            {"p": player_id, "e": event_id},
        )
        self._conn.commit()
        return cur.rowcount == 1

    def player_has_stats(self, player_id: int) -> bool:
        """True if delete_player() would refuse on account of the player's
        games. A seat with nothing recorded counts: deleting it would leave the
        table a player short."""
        cur = self._conn.execute(
            f"SELECT 1 WHERE {_PLAYER_IN_A_GAME}", {"p": player_id}
        )
        return cur.fetchone() is not None

    # --- reset -------------------------------------------------------------
    #
    # Deliberately not reachable from any route. Wiping results is a between-
    # events operation, and a button that does it is one misclick away from
    # ending a live event. scripts/reset.py is the interface.

    def count_results(self, event_id: int) -> tuple[int, int]:
        """(games, turn_rows) recorded for the event. What a reset would destroy.

        Counts turns, not death/win rows: turns are where the night's work is,
        and quoting "4 rows" at an operator who entered ninety turn cycles would
        badly understate what they are about to lose.

        Counted rather than derived from len(all_stats()): the confirmation
        screen quotes these numbers back to the operator as the thing they are
        agreeing to lose, so they come from the same tables the delete targets.
        """
        cur = self._conn.execute(
            """
            SELECT
              (SELECT count(*) FROM games WHERE event_id = :e) AS games,
              (SELECT count(*) FROM turn_stats
                 WHERE game_id IN (SELECT game_id FROM games WHERE event_id = :e)) AS rows
            """,
            {"e": event_id},
        )
        row = cur.fetchone()
        return int(row["games"]), int(row["rows"])

    def clear_results(self, event_id: int) -> tuple[int, int]:
        """Delete every game and stat row for the event; roster untouched.

        Returns (games_deleted, turn_rows_deleted). The deletes are written out
        rather than left to ON DELETE CASCADE so the count is real — a cascade
        reports nothing, and "deleted 0 rows" is the one answer an operator must
        be able to trust after asking to wipe their data. Seating goes too: a
        table set for a match that no longer has results is not a result, it is
        a stale arrangement that would silently reappear on the entry screen.

        Both statements share a transaction: a half-applied reset would leave
        games with no stats, which reads on the display as a played round where
        everybody scored zero.
        """
        scope = "game_id IN (SELECT game_id FROM games WHERE event_id = ?)"
        with self._conn:
            stats = self._conn.execute(
                f"DELETE FROM turn_stats WHERE {scope}", (event_id,)
            ).rowcount
            for table in ("turn_damage", "game_player_stats", "game_seats"):
                self._conn.execute(f"DELETE FROM {table} WHERE {scope}", (event_id,))
            # Decks go for the same reason seating does, and need their own
            # statement because they hang off the event, not off a game_id.
            self._conn.execute(
                "DELETE FROM match_commanders WHERE event_id = ?", (event_id,)
            )
            games = self._conn.execute(
                "DELETE FROM games WHERE event_id = ?", (event_id,)
            ).rowcount
        return games, stats

    def clear_roster(self, event_id: int) -> int:
        """Delete every player in the event. Returns the number removed.

        Unguarded, unlike delete_player: this exists precisely to throw away a
        test roster, and stats cascade away with it. Call clear_results() first
        if you want the count of what you destroyed.
        """
        cur = self._conn.execute("DELETE FROM players WHERE event_id = ?", (event_id,))
        self._conn.commit()
        return cur.rowcount

    # --- games -------------------------------------------------------------

    def find_game(self, event_id: int, pod: str, match_no: int) -> int | None:
        cur = self._conn.execute(
            "SELECT game_id FROM games WHERE event_id = ? AND pod = ? AND match_no = ?",
            (event_id, pod, match_no),
        )
        row = cur.fetchone()
        return int(row["game_id"]) if row is not None else None

    def get_or_create_game(self, event_id: int, pod: str, match_no: int) -> int:
        existing = self.find_game(event_id, pod, match_no)
        if existing is not None:
            return existing
        try:
            cur = self._conn.execute(
                "INSERT INTO games (event_id, pod, match_no) VALUES (?, ?, ?)",
                (event_id, pod, match_no),
            )
            self._conn.commit()
            return int(cur.lastrowid)
        except sqlite3.IntegrityError:
            # The other tracker created it between our SELECT and INSERT. The
            # unique index on (event_id, pod, match_no) is what makes this safe.
            self._conn.rollback()
            game_id = self.find_game(event_id, pod, match_no)
            if game_id is None:
                raise
            return game_id

    def games(self, event_id: int) -> list[Game]:
        """Every game of the event, in the order a results sheet reads: match
        first, then pod. all_stats() carries only a game_id, so this is what
        turns a stat row back into "Pod A, round 2"."""
        cur = self._conn.execute(
            "SELECT game_id, pod, match_no FROM games WHERE event_id = ? "
            "ORDER BY match_no, pod",
            (event_id,),
        )
        # pod and round are nullable: schema.sql leaves them so that an ad-hoc
        # game can escape the unique index on (event, pod, round). Nothing
        # creates one yet, but `int(None)` would be a 500 on /results and
        # /results.csv the day the games CRUD above does — and dropping the row
        # instead would be worse, because a stat row whose game vanished is
        # silently absent from the sheet. Sentinels keep it visible and sort it
        # ahead of round 1, where it reads as the anomaly it is.
        return [
            Game(
                game_id=int(r["game_id"]),
                pod="?" if r["pod"] is None else str(r["pod"]),
                match_no=0 if r["match_no"] is None else int(r["match_no"]),
            )
            for r in cur.fetchall()
        ]

    # --- seating -----------------------------------------------------------

    def seat_players(self, game_id: int, names: list[str]) -> None:
        """Set who is at this table, in turn order. Replaces any prior seating.

        Seats are assigned 1..n from the order given, which is the order play
        passes around the table -- the entry screen walks it to decide whose
        turn is next.

        Reseating a game that already has turns recorded is allowed and deletes
        nothing: the turns stay attached to their players, and every total
        counts only players seated here now (_SEATED_DAMAGE, and the derived
        stats being driven from game_seats). So a player moved off the table
        takes no score with them and leaves none behind, and seating them back
        restores it. An empty `names` clears the table, which is how a swap
        between the two pods is made when every player is already dealt.
        """
        ids = [self._player_id(game_id, n) for n in names]
        with self._conn:
            self._conn.execute("DELETE FROM game_seats WHERE game_id = ?", (game_id,))
            self._conn.executemany(
                "INSERT INTO game_seats (game_id, player_id, seat) VALUES (?, ?, ?)",
                [(game_id, pid, seat) for seat, pid in enumerate(ids, start=1)],
            )

    def seating(self, game_id: int) -> list[str]:
        """The table's players in turn order. Empty if the table is not set."""
        cur = self._conn.execute(
            """
            SELECT p.name FROM game_seats s
            JOIN players p ON p.player_id = s.player_id
            WHERE s.game_id = ? ORDER BY s.seat
            """,
            (game_id,),
        )
        return [r["name"] for r in cur.fetchall()]

    def seated_elsewhere(
        self, event_id: int, match_no: int, exclude_game: int | None
    ) -> set[str]:
        """Players already seated at another pod for the same match.

        Seating rotates every match, so the seating form has to stop the same
        player being dealt into pod A and pod B of match 2 -- which would give
        them two rows for one match and quietly inflate their win points.

        `exclude_game` is None for a table nobody has opened yet, which is the
        second pod of every match: everyone seated anywhere is then elsewhere.
        A bare `game_id <> NULL` would match no rows at all.
        """
        cur = self._conn.execute(
            """
            SELECT p.name FROM game_seats s
            JOIN games g ON g.game_id = s.game_id
            JOIN players p ON p.player_id = s.player_id
            WHERE g.event_id = :e AND g.match_no = :m
              AND (:x IS NULL OR s.game_id <> :x)
            """,
            {"e": event_id, "m": match_no, "x": exclude_game},
        )
        return {r["name"] for r in cur.fetchall()}

    # --- commanders --------------------------------------------------------

    def commanders_for_match(self, event_id: int, match_no: int) -> dict[str, str]:
        """{player name: deck} for one match. Players with none are absent."""
        cur = self._conn.execute(
            """
            SELECT p.name AS name, c.commander AS commander
            FROM match_commanders c
            JOIN players p ON p.player_id = c.player_id
            WHERE c.event_id = ? AND c.match_no = ?
            """,
            (event_id, match_no),
        )
        return {r["name"]: r["commander"] for r in cur.fetchall()}

    def all_match_commanders(self, event_id: int) -> dict[tuple[str, int], str]:
        """Every deck of the night, keyed (player name, match_no).

        One query rather than one per match: the results sheet and both CSVs
        annotate per-game rows, and a lookup per row is the N+1 this avoids.
        """
        cur = self._conn.execute(
            """
            SELECT p.name AS name, c.match_no AS match_no, c.commander AS commander
            FROM match_commanders c
            JOIN players p ON p.player_id = c.player_id
            WHERE c.event_id = ?
            """,
            (event_id,),
        )
        return {(r["name"], int(r["match_no"])): r["commander"] for r in cur.fetchall()}

    def set_match_commanders(
        self, event_id: int, match_no: int, by_player: dict[str, str]
    ) -> None:
        """Record which deck each named player brought to this match.

        Only the named players are touched. The two pods of a match are entered
        by two different trackers, and a write from one table must not blank
        what the other just saved -- so this is not a delete-and-rewrite of the
        match the way seat_players is of a table.

        A blank value deletes the row instead of storing an empty string, which
        is what keeps "no deck recorded" a single state (see schema.sql). That
        also makes the operation idempotent for a form submitted unchanged.

        One transaction for the whole table: a half-applied save would leave the
        pod with some players' decks from this submit and some from the last.
        """
        resolved = [(self._event_player_id(event_id, n), c.strip()) for n, c in by_player.items()]
        with self._conn:
            for player_id, commander in resolved:
                if commander:
                    self._conn.execute(
                        """
                        INSERT INTO match_commanders
                               (event_id, player_id, match_no, commander)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT (event_id, player_id, match_no)
                        DO UPDATE SET commander = excluded.commander
                        """,
                        (event_id, player_id, match_no, commander),
                    )
                else:
                    self._conn.execute(
                        """
                        DELETE FROM match_commanders
                        WHERE event_id = ? AND player_id = ? AND match_no = ?
                        """,
                        (event_id, player_id, match_no),
                    )

    # --- turns -------------------------------------------------------------

    def save_turn(self, game_id: int, player: str, turn: TurnStat) -> None:
        """Upsert one player's one turn cycle, damage grid included.

        The damage rows are deleted and rewritten rather than upserted one by
        one: a correction that drops an opponent's damage to zero has to remove
        the row, and an upsert alone would leave the old value behind.
        """
        player_id = self._player_id(game_id, player)
        for name in ("attacking_creatures", "cmdr_dmg_dealt", "noncombat_dmg_dealt",
                     "opps_eliminated", "round_no"):
            self._check_width(name, getattr(turn, name))

        targets: list[tuple[int, int]] = []
        for target, dmg in turn.damage.items():
            self._check_width(f"damage[{target}]", dmg)
            if dmg == 0:
                # Storing an explicit zero would be harmless for the sums but it
                # is a row per opponent per turn of nothing, and MAX() over the
                # taken aggregate reads the same either way.
                continue
            target_id = self._player_id(game_id, target)
            if target_id == player_id:
                raise ValueError(f"{player!r} cannot deal combat damage to themselves")
            targets.append((target_id, dmg))

        with self._conn:
            self._conn.execute(
                """
                INSERT INTO turn_stats (
                    game_id, player_id, round_no,
                    attacking_creatures, cmdr_dmg_dealt, noncombat_dmg_dealt, opps_eliminated
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(game_id, player_id, round_no) DO UPDATE SET
                    attacking_creatures=excluded.attacking_creatures,
                    cmdr_dmg_dealt=excluded.cmdr_dmg_dealt,
                    noncombat_dmg_dealt=excluded.noncombat_dmg_dealt,
                    opps_eliminated=excluded.opps_eliminated
                """,
                (game_id, player_id, turn.round_no, turn.attacking_creatures,
                 turn.cmdr_dmg_dealt, turn.noncombat_dmg_dealt, turn.opps_eliminated),
            )
            # Only hits on players seated here now: the form shows no box for
            # anyone else, so a hit on somebody reseated away was not
            # resubmitted, and deleting it would make the reseat destructive.
            self._conn.execute(
                """
                DELETE FROM turn_damage
                WHERE game_id = ? AND player_id = ? AND round_no = ?
                  AND target_id IN (SELECT player_id FROM game_seats WHERE game_id = ?)
                """,
                (game_id, player_id, turn.round_no, game_id),
            )
            self._conn.executemany(
                """
                INSERT INTO turn_damage (game_id, player_id, round_no, target_id, combat_dmg)
                VALUES (?, ?, ?, ?, ?)
                """,
                [(game_id, player_id, turn.round_no, tid, dmg) for tid, dmg in targets],
            )

    def turn_for(self, game_id: int, player: str, round_no: int) -> TurnStat | None:
        cur = self._conn.execute(
            """
            SELECT t.attacking_creatures, t.cmdr_dmg_dealt, t.noncombat_dmg_dealt,
                   t.opps_eliminated
            FROM turn_stats t
            JOIN players p ON p.player_id = t.player_id
            JOIN games g ON g.game_id = t.game_id AND g.event_id = p.event_id
            WHERE t.game_id = ? AND p.name = ? AND t.round_no = ?
            """,
            (game_id, player, round_no),
        )
        row = cur.fetchone()
        if row is None:
            return None
        return TurnStat(
            round_no=round_no,
            attacking_creatures=int(row["attacking_creatures"]),
            cmdr_dmg_dealt=int(row["cmdr_dmg_dealt"]),
            noncombat_dmg_dealt=int(row["noncombat_dmg_dealt"]),
            opps_eliminated=int(row["opps_eliminated"]),
            damage=self._turn_damage(game_id, player, round_no),
        )

    def _turn_damage(self, game_id: int, player: str, round_no: int) -> dict[str, int]:
        cur = self._conn.execute(
            """
            SELECT tgt.name AS target, d.combat_dmg
            FROM turn_damage d
            JOIN players p ON p.player_id = d.player_id
            JOIN players tgt ON tgt.player_id = d.target_id
            WHERE d.game_id = ? AND p.name = ? AND d.round_no = ?
            """,
            (game_id, player, round_no),
        )
        return {r["target"]: int(r["combat_dmg"]) for r in cur.fetchall()}

    def rounds_played(self, game_id: int) -> int:
        """Highest turn cycle recorded at this table, 0 if play has not started.

        The table shares one round counter rather than each player keeping their
        own: a turn cycle is a lap of the table, and letting the counters drift
        apart would make "round 4" mean different points of the game for
        different players.
        """
        cur = self._conn.execute(
            """
            SELECT COALESCE(MAX(t.round_no), 0) AS n FROM turn_stats t
            JOIN game_seats s ON s.game_id = t.game_id AND s.player_id = t.player_id
            WHERE t.game_id = ?
            """,
            (game_id,),
        )
        return int(cur.fetchone()["n"])

    def turn_grid(self, game_id: int) -> dict[tuple[str, int], TurnStat]:
        """Every recorded turn at a table, keyed by (player, round_no).

        One query for the whole table: the entry screen shows a grid of who has
        entered what, and doing it per cell was N+1 round-trips against a
        database two trackers are already writing to.
        """
        cur = self._conn.execute(
            """
            SELECT p.name AS player, t.round_no, t.attacking_creatures,
                   t.cmdr_dmg_dealt, t.noncombat_dmg_dealt, t.opps_eliminated
            FROM turn_stats t
            JOIN players p ON p.player_id = t.player_id
            WHERE t.game_id = ?
            """,
            (game_id,),
        )
        rows = cur.fetchall()
        dmg_cur = self._conn.execute(
            f"""
            SELECT p.name AS player, d.round_no, tgt.name AS target, d.combat_dmg
            FROM ({_SEATED_DAMAGE}) d
            JOIN players p ON p.player_id = d.player_id
            JOIN players tgt ON tgt.player_id = d.target_id
            WHERE d.game_id = ?
            """,
            (game_id,),
        )
        damage: dict[tuple[str, int], dict[str, int]] = {}
        for r in dmg_cur.fetchall():
            damage.setdefault((r["player"], int(r["round_no"])), {})[r["target"]] = int(
                r["combat_dmg"]
            )
        return {
            (r["player"], int(r["round_no"])): TurnStat(
                round_no=int(r["round_no"]),
                attacking_creatures=int(r["attacking_creatures"]),
                cmdr_dmg_dealt=int(r["cmdr_dmg_dealt"]),
                noncombat_dmg_dealt=int(r["noncombat_dmg_dealt"]),
                opps_eliminated=int(r["opps_eliminated"]),
                damage=damage.get((r["player"], int(r["round_no"])), {}),
            )
            for r in rows
        }

    def all_turns(self, event_id: int) -> list[RecordedTurn]:
        """Every turn recorded in the event, for the turn-level export.

        Two queries and an in-memory join rather than one query per turn: a
        three-match night is several hundred turns, and the export is a single
        request that should not become several hundred round trips.

        Only players seated at the game now, like the derived stats: a turn
        left behind by a reseat would otherwise put one player in both pods of
        a match on the sheet.
        """
        cur = self._conn.execute(
            """
            SELECT t.game_id, p.name AS player, t.round_no, t.attacking_creatures,
                   t.cmdr_dmg_dealt, t.noncombat_dmg_dealt, t.opps_eliminated
            FROM turn_stats t
            JOIN game_seats s ON s.game_id = t.game_id AND s.player_id = t.player_id
            JOIN games g ON g.game_id = t.game_id
            JOIN players p ON p.player_id = t.player_id
            WHERE g.event_id = ?
            """,
            (event_id,),
        )
        rows = cur.fetchall()

        dmg_cur = self._conn.execute(
            f"""
            SELECT d.game_id, p.name AS player, d.round_no, tgt.name AS target, d.combat_dmg
            FROM ({_SEATED_DAMAGE}) d
            JOIN games g ON g.game_id = d.game_id
            JOIN players p ON p.player_id = d.player_id
            JOIN players tgt ON tgt.player_id = d.target_id
            WHERE g.event_id = ?
            """,
            (event_id,),
        )
        damage: dict[tuple[int, str, int], dict[str, int]] = {}
        for r in dmg_cur.fetchall():
            key = (int(r["game_id"]), r["player"], int(r["round_no"]))
            damage.setdefault(key, {})[r["target"]] = int(r["combat_dmg"])

        return [
            RecordedTurn(
                game_id=int(r["game_id"]),
                player=r["player"],
                turn=TurnStat(
                    round_no=int(r["round_no"]),
                    attacking_creatures=int(r["attacking_creatures"]),
                    cmdr_dmg_dealt=int(r["cmdr_dmg_dealt"]),
                    noncombat_dmg_dealt=int(r["noncombat_dmg_dealt"]),
                    opps_eliminated=int(r["opps_eliminated"]),
                    damage=damage.get(
                        (int(r["game_id"]), r["player"], int(r["round_no"])), {}
                    ),
                ),
            )
            for r in rows
        ]

    def damage_matrix(self, event_id: int) -> dict[int, dict[tuple[str, str], int]]:
        """Per game: who dealt how much combat damage to whom, over the match.

        Summed in SQL rather than by walking all_turns(), because the sheet
        wants the totals and not the turns they came from -- and a GROUP BY is
        the one thing the database is unambiguously better at than we are.
        """
        cur = self._conn.execute(
            f"""
            SELECT d.game_id, p.name AS dealer, tgt.name AS target,
                   SUM(d.combat_dmg) AS dmg
            FROM ({_SEATED_DAMAGE}) d
            JOIN games g ON g.game_id = d.game_id
            JOIN players p ON p.player_id = d.player_id
            JOIN players tgt ON tgt.player_id = d.target_id
            WHERE g.event_id = ?
            GROUP BY d.game_id, d.player_id, d.target_id
            """,
            (event_id,),
        )
        out: dict[int, dict[tuple[str, str], int]] = {}
        for r in cur.fetchall():
            out.setdefault(int(r["game_id"]), {})[(r["dealer"], r["target"])] = int(r["dmg"])
        return out

    # --- the death/win section ---------------------------------------------

    def save_final(self, game_id: int, player: str, final: FinalStat) -> None:
        """Upsert the three values known only once a player is out."""
        self.save_finals(game_id, {player: final})

    def save_finals(self, game_id: int, by_player: dict[str, FinalStat]) -> None:
        """Upsert the death/win section for several players at once.

        One attack can put two players out together, and their placements are
        one fact split across two rows: the finishing order. Written row by row,
        a failure on the second would leave the first holding a placement that
        the order it came from never finished -- so the whole group goes in one
        transaction, resolved before any of it is written.

        Only the named players are touched. Everybody else at the table is
        mid-game and has no placement yet, which is what scoring reads as
        "still playing".
        """
        resolved: list[tuple[int, FinalStat]] = []
        for player, final in by_player.items():
            for name in ("final_life", "total_graveyard"):
                self._check_width(name, getattr(final, name))
            if final.placement is not None:
                self._check_width("placement", final.placement)
            resolved.append((self._player_id(game_id, player), final))

        with self._conn:
            for player_id, final in resolved:
                self._conn.execute(
                    """
                    INSERT INTO game_player_stats
                           (game_id, player_id, placement, final_life, total_graveyard)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(game_id, player_id) DO UPDATE SET
                        placement=excluded.placement,
                        final_life=excluded.final_life,
                        total_graveyard=excluded.total_graveyard
                    """,
                    (game_id, player_id, final.placement, final.final_life,
                     final.total_graveyard),
                )

    def final_for(self, game_id: int, player: str) -> FinalStat | None:
        cur = self._conn.execute(
            """
            SELECT f.placement, f.final_life, f.total_graveyard
            FROM game_player_stats f
            JOIN players p ON p.player_id = f.player_id
            WHERE f.game_id = ? AND p.name = ?
            """,
            (game_id, player),
        )
        row = cur.fetchone()
        if row is None:
            return None
        return FinalStat(
            placement=None if row["placement"] is None else int(row["placement"]),
            final_life=int(row["final_life"] or 0),
            total_graveyard=int(row["total_graveyard"]),
        )

    # --- derived per-game stats (what scoring consumes) ---------------------

    def stats_for_game(self, game_id: int) -> list[GamePlayerStat]:
        cur = self._conn.execute(
            # "placement IS NULL" first: SQLite sorts NULLs low, so without it the
            # players still alive would be listed above the winner.
            f"{_DERIVED_STATS} WHERE seats.game_id = ?"
            " ORDER BY f.placement IS NULL, f.placement, seats.seat",
            (game_id,),
        )
        return [_game_player_stat(r) for r in cur.fetchall()]

    def stat_for(self, game_id: int, player: str) -> GamePlayerStat | None:
        return next((s for s in self.stats_for_game(game_id) if s.player == player), None)

    def all_stats(self, event_id: int) -> list[GamePlayerStat]:
        cur = self._conn.execute(
            f"{_DERIVED_STATS} WHERE gm.event_id = ?", (event_id,)
        )
        return [_game_player_stat(r) for r in cur.fetchall()]

    # --- helpers -----------------------------------------------------------

    def _event_player_id(self, event_id: int, name: str) -> int:
        """Resolve a name within an event, for the tables keyed on the event
        rather than on a game. Raises like _player_id rather than skipping the
        row: a caller writing for somebody who is not on the roster has a bug,
        and a silent skip would lose the tracker's typing without a word."""
        cur = self._conn.execute(
            "SELECT player_id FROM players WHERE event_id = ? AND name = ?",
            (event_id, name),
        )
        row = cur.fetchone()
        if row is None:
            raise ValueError(f"unknown player {name!r} for event {event_id}")
        return int(row["player_id"])

    def _player_id(self, game_id: int, name: str) -> int:
        """Resolve a name within the game's own event, so two events may share
        player names."""
        cur = self._conn.execute(
            """
            SELECT p.player_id
            FROM players p
            JOIN games g ON g.event_id = p.event_id
            WHERE g.game_id = ? AND p.name = ?
            """,
            (game_id, name),
        )
        row = cur.fetchone()
        if row is None:
            raise ValueError(f"unknown player {name!r} for game {game_id}")
        return int(row["player_id"])

    def _check_width(self, field: str, value: int) -> None:
        """Last line of defence before binding. Routes bound their own input
        first (models.STAT_MAX); without this an over-wide value raised out of
        the write *before* the INSERT, so the row was silently never written and
        htmx showed the tracker nothing at all (KG-10)."""
        if not SQLITE_INT_MIN <= value <= SQLITE_INT_MAX:
            raise ValueTooWideForStorage(field, value)
