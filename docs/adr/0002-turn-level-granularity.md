# 0002 — Turn-level granularity, and per-opponent damage

Date: 2026-09-11
Status: accepted. **Supersedes the granularity decision in
[ADR 0001](0001-architecture-decisions.md)**; every other decision there
(FastAPI + HTMX, SQLite behind a `Storage` protocol, SSE, config-driven prizes)
stands unchanged.

## Context

ADR 0001 recorded that "everything reduces to one record per player per game —
no turn-by-turn data is needed, because every prize is either a per-game total
or a per-game peak." That was true of the prizes, and it is why the model was
built that way.

Two things came out of reviewing the event owner's own tracking sheet against
the running app.

**The entry form could not be used during a game.** `placement` was required on
every save. A tracker three turns into a match does not know the finishing order
— nobody does — so there was no way to record the turn they had just watched.
The peaks fieldset simultaneously instructed them to "bump these during the
round". The form asked for live entry and refused to accept it.

**The sheet is turn-shaped.** Its columns are grouped by *when in the turn* they
are filled in: beginning of player turn, beginning of combat, the assign-combat-
damage step, end of combat, end of turn, and finally "Entered at Player Death or
Win". A row is one player's one turn. It also breaks combat damage out per
opponent, one column per player on the roster.

Per-opponent damage cannot be stored in a per-game scalar at all, and the owner
asked for it directly.

## Decision

Store one row per player per **turn cycle**, plus a small per-game section for
the values that are only knowable once a player is out.

- `game_seats` — who is at a table, in turn order.
- `turn_stats` — attacking creatures, commander damage, non-combat damage,
  eliminations, per player per turn.
- `turn_damage` — combat damage to one named opponent in one turn.
- `game_player_stats` — shrinks to placement, final life, total graveyard.

`placement` becomes nullable. `games.round` is renamed `match_no`, because the
sheet uses "Round #" for the turn cycle and the collision was going to cause a
bug. `peak_graveyard` becomes `total_graveyard`: the sheet counts the pile once
at the end rather than tracking a maximum, which is a different number and a
deliberate change of basis for the Mill prize.

**`app/scoring.py` is not changed.** The repository aggregates turns back into
the `GamePlayerStat` the engine already consumes — sums for totals, maxima for
peaks — so the verified core and its tests carried over untouched. That
translation lives in `_DERIVED_STATS` in `app/repository.py` and is the only
place the two granularities meet.

## Consequences

**Good.**

- A turn can be saved while the game is running. This was the actual blocker.
- The peaks stop being hand-tracked. `biggest_attack_dealt`, `biggest_attack_taken`
  and `most_creatures_in_attack` are now derived, so the single most
  forget-prone part of live tracking is gone — and the numbers are auditable
  after the night, which a hand-maintained running maximum never was.
- Pod membership becomes real data. It used to be inferred from "whoever has a
  stat row", which was circular; the entry form could not offer a pod's players
  until somebody had already saved one. Seating also stops the same player being
  dealt into two pods in one match, which would have doubled their win points.
- The damage grid shows three opponents rather than the roster's eight. The
  spreadsheet cannot do this; it is the clearest thing the app buys over the
  sheet.
- Prizes that need per-opponent data are now expressible — archenemy, best
  rivalry, kingmaker — though none is configured yet.

**Bad, and accepted.**

- **Roughly ten times the data entry.** A four-player match running ten turn
  cycles is ~40 rows instead of 4, each with a three-cell damage grid, entered
  on a phone. This is the cost ADR 0001 was avoiding and it is real. It is
  mitigated, not removed, by: most cells being blank on most turns (a blank is
  zero and stores no row), the peaks no longer being entered at all, and the
  form advancing to the next seat on save so walking the table needs no
  selection. The event owner chose this trade knowing the cost.
- A table must be seated before anything can be entered. One extra step per pod
  per match, and it is a hard prerequisite rather than a convenience.
- "Complete" on the results sheet now means every player has *finished*, not
  every player has a row — seating creates rows, so counting rows would have
  called an unplayed match complete.

**Migration.** There is none. The column changes are destructive and
`app/db.py` applies `schema.sql` with `CREATE TABLE IF NOT EXISTS`, which will
not alter an existing table. A deployed database must be reset (`/admin` danger
zone, or `scripts/reset.py --all --yes`, both of which back up first). This was
acceptable because the change landed before the event, against a placeholder
roster.
