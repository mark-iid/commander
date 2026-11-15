"""SQLite connection + schema bootstrap.

Kept intentionally thin. Business code should use the `Storage` protocol via
`get_storage()`, not this module's SQLite internals, so the storage backend can
change without touching callers.

Connections are per-thread: FastAPI runs sync endpoints in a threadpool, and a
single sqlite3 connection shared across threads invites cursor races. WAL mode
means the extra connections still read without blocking the writer.
"""
from __future__ import annotations

import os
import pathlib
import sqlite3
import threading
from contextlib import closing
from datetime import datetime

from app.repository import SQLiteStorage, Storage

_SCHEMA = pathlib.Path(__file__).with_name("schema.sql")

_local = threading.local()
_all_conns: list[sqlite3.Connection] = []
_lock = threading.Lock()
# Bumped by close_connections(); a thread whose cached connection predates the
# current generation reconnects instead of using a closed handle.
_generation = 0


def db_path() -> str:
    """Read at call time so tests (and `.env`) can point at another file."""
    return os.environ.get("DB_PATH", "commander.db")


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(db_path(), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    # Two trackers can write concurrently; wait out the other's lock rather than
    # failing the save with "database is locked".
    conn.execute("PRAGMA busy_timeout = 5000;")
    return conn


def get_conn() -> sqlite3.Connection:
    cached = getattr(_local, "conn", None)
    if cached is not None and cached[0] == _generation:
        return cached[1]
    conn = connect()
    with _lock:
        _local.conn = (_generation, conn)
        _all_conns.append(conn)
    return conn


def get_storage() -> Storage:
    """The single place the backend is chosen. Swap in PostgresStorage here."""
    return SQLiteStorage(get_conn())


def init_db(conn: sqlite3.Connection | None = None) -> None:
    conn = conn or get_conn()
    conn.executescript(_SCHEMA.read_text())
    conn.commit()


class BackupFailed(Exception):
    """A backup that could not be written.

    Raised in place of both OSError and sqlite3.Error so one `except` covers the
    whole operation and no caller has to import sqlite3 (ADR 0001).

    The two-exception part is the bug this class exists for. `sqlite3.Error` is
    not an OSError subclass, so a corrupt or unwritable database raised
    sqlite3.DatabaseError straight past the reset route's `except OSError` and
    became a 500. htmx does not swap 5xx, so the operator got no backup, no
    reset and no message — a Reset button that silently did nothing, which is
    the same failure shape as KG-10.
    """


def backup_database() -> pathlib.Path:
    """Snapshot the database into `backups/` beside it. Returns the new file.

    Uses SQLite's own backup API rather than copying the file. A WAL database
    being written by another process has committed data living in the -wal file
    that a plain `cp` of the main file does not capture, so the copy can restore
    to a state that never existed. The backup API takes a consistent snapshot of
    a live database, which is the whole point of taking one before a reset.

    A backend detail, so it lives here rather than behind the Storage protocol:
    Postgres would back up by an entirely different mechanism.

    Raises BackupFailed if anything goes wrong. Both connections are closed on
    every path: `with sqlite3.connect(...)` commits but does not close, so the
    destination handle used to leak once per reset.
    """
    db_file = pathlib.Path(db_path()).resolve()
    dest_dir = db_file.parent / "backups"
    dest = dest_dir / f"{db_file.name}.{datetime.now():%Y%m%d-%H%M%S}"
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(db_file)) as src:
            with closing(sqlite3.connect(dest)) as out:
                src.backup(out)
    except (OSError, sqlite3.Error) as exc:
        raise BackupFailed(str(exc)) from exc
    return dest


def close_connections() -> None:
    """Drop every pooled connection. For tests and shutdown."""
    global _generation
    with _lock:
        for conn in _all_conns:
            try:
                conn.close()
            except sqlite3.Error:
                pass
        _all_conns.clear()
        _generation += 1
