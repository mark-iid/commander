#!/usr/bin/env python3
"""Reset the tracker's data — after a rehearsal, or between events.

Two levels, because they are not the same operation:

  --results   Wipe every game and stat row. The roster stays. Use this between
              events, or after a dry run with the real players.
  --all       Also wipe the roster, then reseed it from `roster:` in event.yaml.
              Use this to throw away test players. The event row itself is kept
              on purpose: the running server holds its event_id in app.state, so
              deleting it would mean every save failed until someone restarted
              the service. Keeping it makes a reset safe to run live.

Nothing happens without --yes; without it this prints what it *would* delete.
A backup is taken first unless --no-backup (see app.db.backup_database).

  python scripts/reset.py                       # show what's there
  python scripts/reset.py --results --yes
  python scripts/reset.py --all --yes

The same two levels are available in /admin under "Danger zone", behind a
two-step confirmation. This CLI is the one that works when the app will not
start.
"""
from __future__ import annotations

import argparse
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def load_env_file(path: pathlib.Path) -> None:
    """Minimal KEY=VALUE reader — the app has no dotenv dependency.

    Existing environment variables win, so an explicit `DB_PATH=... python
    scripts/reset.py` overrides the file rather than being silently ignored.

    Without this the script would default DB_PATH to ./commander.db and cheerfully
    report "nothing to delete" while the real database sat untouched elsewhere —
    the worst failure mode available to a reset tool, because it looks like success.
    """
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    level = parser.add_mutually_exclusive_group()
    level.add_argument("--results", action="store_true",
                       help="delete all games and stats; keep the roster")
    level.add_argument("--all", action="store_true", dest="all_",
                       help="also delete the roster and reseed it from event.yaml")
    parser.add_argument("--yes", action="store_true", help="actually do it")
    parser.add_argument("--no-backup", action="store_true", help="skip the backup")
    parser.add_argument("--env-file", default=str(ROOT / ".env"),
                        help="KEY=VALUE file to read DB_PATH/EVENT_CONFIG from")
    args = parser.parse_args(argv)

    load_env_file(pathlib.Path(args.env_file))

    from app.config import load_event, load_roster
    from app.db import BackupFailed, backup_database, db_path, get_storage, init_db

    db_file = pathlib.Path(db_path()).resolve()
    event = load_event()

    init_db()
    storage = get_storage()
    event_id, created = storage.ensure_event(event.name, event.games_per_player)

    roster = storage.roster(event_id)
    # count_results(), not len(all_stats()): all_stats() returns a derived row
    # per SEATED player, so it counts empty seats at a table nobody has played
    # yet. The operator needs the number the delete below will actually report.
    game_count, turn_rows = storage.count_results(event_id)

    print(f"database : {db_file}")
    print(f"event    : {event.name}" + ("  (created just now — it was empty)" if created else ""))
    print(f"roster   : {len(roster)} player(s){': ' + ', '.join(roster) if roster else ''}")
    print(f"recorded : {game_count} game(s), {turn_rows} stat row(s)")

    if not (args.results or args.all_):
        print("\nNothing changed. Pass --results (wipe games/stats) or --all "
              "(also reset the roster), plus --yes.")
        return 0

    plan = "games + stats" if args.results else "games + stats + roster (reseeded from config)"
    if not args.yes:
        print(f"\nWould delete: {plan}. Re-run with --yes to do it.")
        return 0

    if not args.no_backup:
        # Same invariant as the /admin danger zone: no backup, no delete.
        try:
            print(f"\nbackup   : {backup_database()}")
        except BackupFailed as exc:
            print(f"\nbackup failed: {exc}", file=sys.stderr)
            print("Nothing was deleted. Fix the backup location, or re-run with "
                  "--no-backup if you genuinely do not want one.", file=sys.stderr)
            return 1

    games, rows = storage.clear_results(event_id)
    print(f"deleted  : {games} game(s), {rows} stat row(s)")

    if args.all_:
        removed = storage.clear_roster(event_id)
        seed = load_roster()
        storage.sync_roster(event_id, seed)
        print(f"roster   : removed {removed}, reseeded {len(storage.roster(event_id))} "
              f"from {os.environ.get('EVENT_CONFIG', 'config/event.yaml')}")
        if not seed:
            print("           (config has no `roster:` list — add players in /admin)")

    # The SSE broadcaster is in-process, so a leaderboard already on screen has
    # no way to hear about a change made from another process.
    print("\nDone. Reload any open /display tab — it will not update on its own.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
