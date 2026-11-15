#!/usr/bin/env python3
"""Turn a live Commander Tracker database into SQL for D1.

Phase 1 of ADR 0003: the existing night moves across once, and after that the
old SQLite file is history. Reads the database and the event config, writes
INSERT statements against migrations/0001_initial.sql:

    python3 scripts/export_for_d1.py \\
        --db /var/lib/commander-tracker/commander.db \\
        --config /opt/commander-tracker/config/event.yaml \\
        --out import.sql

    wrangler d1 execute commander-tracker --file=import.sql   # --remote to ship it

The database is opened read-only. Nothing here writes to it, and nothing here
talks to Cloudflare: the output is a file to read before you run it.

WHAT COMES FROM WHERE, because the two sources disagree and it matters:

  * **Players come from the database, not the config.** `roster:` in the YAML
    seeds the players table once, when the event row is first created, and
    /admin owns it from then on. On the real 2026-11-14 event the YAML still
    said Player6/Player7/Player8 while the database had the names people
    actually played under. The database is the record.
  * Roster ORDER is the players' `player_id` order, which is what the old
    repository's `roster()` returned and therefore what the scoring engine used
    as its last-resort tiebreaker. It becomes an explicit `roster_position`.
  * `prize_ineligible` is a list of names in the config; it becomes a
    `prize_eligible` flag on the player. A name in the config matching nobody
    on the roster is an error rather than a shrug, because the silent version
    of that mistake is an organiser winning prizes.
  * Prizes, placement points, damage fields, pods and pod size come from the
    config, which is the only place they have ever lived.
"""
from __future__ import annotations

import argparse
import pathlib
import sqlite3
import sys

import yaml

# Dependency order: D1 enforces foreign keys, so a child row before its parent
# fails the import halfway through.
GAME_TABLES = (
    "games",
    "game_seats",
    "turn_stats",
    "turn_damage",
    "game_player_stats",
    "match_commanders",
)


def lit(v: object) -> str:
    """One SQL literal. Deliberately narrow: an unexpected type is a bug to see,
    not something to coerce into a string and ship."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str):
        return "'" + v.replace("'", "''") + "'"
    raise TypeError(f"no SQL literal for {type(v).__name__}: {v!r}")


def insert(table: str, row: dict[str, object]) -> str:
    cols = sorted(row)
    return (
        f"INSERT INTO {table} ({', '.join(cols)})"
        f" VALUES ({', '.join(lit(row[c]) for c in cols)});"
    )


def build(db_path: str, config_path: str) -> list[str]:
    cfg = yaml.safe_load(pathlib.Path(config_path).read_text())
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        events = [dict(r) for r in conn.execute("SELECT * FROM events ORDER BY event_id")]
        if len(events) != 1:
            raise SystemExit(
                f"expected exactly one event in {db_path}, found {len(events)}."
                " The old app only ever served one; a file with several was not"
                " produced by it and this script will not guess which to take."
            )
        event = events[0]
        event_id = event["event_id"]
        players = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM players WHERE event_id = ? ORDER BY player_id", (event_id,)
            )
        ]
        game_rows = {
            t: [dict(r) for r in conn.execute(f"SELECT * FROM {t}")] for t in GAME_TABLES
        }
    finally:
        conn.close()

    scoring = cfg["scoring"]
    ineligible = scoring.get("prize_ineligible") or []
    if isinstance(ineligible, str):  # a lone name without the brackets
        ineligible = [ineligible]
    names = {p["name"] for p in players}
    unknown = [n for n in ineligible if n not in names]
    if unknown:
        raise SystemExit(
            f"prize_ineligible names nobody on the roster: {', '.join(unknown)}."
            f"\nRoster is: {', '.join(sorted(names))}"
            "\nThat is how an organiser silently becomes eligible again, so fix the"
            " config (or the spelling) rather than importing it."
        )

    # pod_size was optional and defaulted to the number of placement tiers, on
    # the reasoning that 1..4 is already the statement that a pod seats four.
    placement_points = {int(k): int(v) for k, v in scoring["placement_points"].items()}
    pod_size = int(cfg["event"].get("pod_size") or len(placement_points))

    # The config lists the pods, but a game can only name one that exists, so
    # take the union and keep the config's order first.
    labels = [str(p) for p in cfg["event"].get("pods") or []]
    for g in game_rows["games"]:
        if g["pod"] is not None and g["pod"] not in labels:
            labels.append(g["pod"])

    out: list[str] = [
        "-- Generated by scripts/export_for_d1.py. Review before running.",
        f"-- Source database: {db_path}",
        f"-- Source config:   {config_path}",
        f"-- Event: {event['name']!r} ({len(players)} players,"
        f" {len(game_rows['games'])} games, {len(game_rows['turn_stats'])} turn rows)",
        "",
        insert(
            "events",
            {
                "event_id": event_id,
                "name": event["name"],
                "date": event["date"],
                "games_per_player": event["games_per_player"],
                "pod_size": pod_size,
                "notes": event["notes"],
            },
        ),
    ]

    out += [
        insert("pods", {"event_id": event_id, "label": label, "position": i + 1})
        for i, label in enumerate(labels)
    ]
    out += [
        insert(
            "players",
            {
                "player_id": p["player_id"],
                "event_id": event_id,
                "name": p["name"],
                "commander": p["commander"],
                "prize_eligible": 0 if p["name"] in ineligible else 1,
                "roster_position": i + 1,
            },
        )
        for i, p in enumerate(players)
    ]
    out += [
        insert("placement_points", {"event_id": event_id, "placement": k, "points": v})
        for k, v in sorted(placement_points.items())
    ]
    out += [
        insert("total_damage_fields", {"event_id": event_id, "field": f, "position": i + 1})
        for i, f in enumerate(scoring["total_damage_fields"])
    ]
    for i, prize in enumerate(cfg["prizes"]):
        tb = prize.get("tiebreak") or {}
        out.append(
            insert(
                "prizes",
                {
                    "event_id": event_id,
                    "key": prize["key"],
                    "name": prize["name"],
                    "metric": prize["metric"],
                    "agg": prize["agg"],
                    "scope": prize["scope"],
                    "tiebreak_field": tb.get("field"),
                    "tiebreak_direction": tb.get("direction"),
                    "tiebreak_scope": tb.get("scope") or "night",
                    "position": i + 1,
                },
            )
        )

    for table in GAME_TABLES:
        out.append("")
        out.append(f"-- {table}: {len(game_rows[table])} rows")
        out += [insert(table, row) for row in game_rows[table]]

    out += [
        "",
        "-- The event the projector and the entry form mean when no event is named.",
        insert("active_event", {"singleton": 1, "event_id": event_id}),
    ]
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--db", required=True, help="the live SQLite database, opened read-only")
    ap.add_argument("--config", required=True, help="the live config/event.yaml")
    ap.add_argument("--out", required=True, help="SQL file to write")
    args = ap.parse_args()

    lines = build(args.db, args.config)
    pathlib.Path(args.out).write_text("\n".join(lines) + "\n")
    statements = sum(1 for line in lines if line.startswith("INSERT"))
    print(f"wrote {args.out}: {statements} statements", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
