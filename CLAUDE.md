# CLAUDE.md — Commander Tracker

Context for Claude Code sessions on this project. Read this first.

## What this is

A stat tracker for a recurring Magic: The Gathering Commander (EDH) tournament night. Players compete across 3 games; trackers record per-game stats; a live leaderboard awards ~11 novelty prizes. Built to be generic and config-driven so anyone can run their own event (different game, different prizes) without touching code. Intended to be open-sourced.

## In progress: the port to Cloudflare Workers (read docs/adr/0003 before touching architecture)

The 2026-11-14 night went well and the event is now recurring, so the project is
being made multi-tournament and taken to GitHub for other people to run. It is
also being **ported to Cloudflare Workers + D1**, in phases. That supersedes the
backend, storage and deployment decisions listed below; the domain model in ADR
0002 carries over whole. Why, what the phases are and what was rejected: `docs/adr/0003`.

**Phase 0 is done and is a gate, not a draft.** `shared/scoring.ts` is a
TypeScript port of `app/scoring.py`, held to the real Fall 2026 night in
`shared/fixtures/fall-2026.json` (8 players, 2 pods, 3 matches, 156 turn rows,
pseudonymous names in the original roster order). Two rules follow:

1. **Change one engine, change both.** `scripts/fixture_expected.py --check`
   recomputes the fixture from Python and runs inside pytest
   (`tests/test_fixture.py`), so Python stays the reference. If the change is
   intended, `--write` adopts it, which then turns
   `shared/scoring.golden.test.ts` red until TypeScript agrees again. Both
   suites green with the engines disagreeing is not a reachable state, and that
   is deliberate.
2. **Stat field names stay snake_case in TypeScript.** Config names these
   fields as strings (`metric: combat_dmg_dealt`), so they are part of the
   config format. Renaming them breaks every `event.yaml`, silently, because an
   unknown metric reads as zero rather than raising.

**Phase 1 is done too.** `migrations/0001_initial.sql` is the D1 schema, with
multi-event folded in: event config, prizes, placement points and pods are rows
now, not `config/event.yaml`. `shared/aggregate.ts` holds the aggregation query,
which was relocated rather than ported (D1 is SQLite, so it is the same text),
and `scripts/export_for_d1.py` carries the existing night across. Read
`docs/D1_MIGRATION.md` before touching any of it. Three more rules:

3. **The aggregation SQL exists twice and must stay identical.**
   `tests/test_aggregate_parity.py` compares `_DERIVED_STATS` in
   `app/repository.py` against `DERIVED_STATS` in `shared/aggregate.ts` token
   for token. Edit one, edit the other. Both copies die when phase 2 deletes
   the Python app.
4. **Never edit an applied migration.** Add `0002_*.sql`. Wrangler tracks what
   it has applied in `d1_migrations`.
5. **`shared/schema.test.ts` is the phase 1 gate**, the same shape as phase 0's:
   apply the migration, load the real night, and require every derived row,
   standing and prize winner to be unchanged. It uses `node:sqlite`, so it needs
   no Cloudflare account.

**Phase 2 is done.** The Worker serves all four surfaces: `/display`,
`/results` (plus both CSVs), `/entry` and `/admin`. Hono over D1, views as
`hono/html` tagged templates, HTMX untouched. Worker tests run inside workerd
against a real D1 built from `migrations/`. Three more rules:

6. **D1 storage is not rolled back between tests** and this plugin version has
   no isolated-storage option (its schema strips unknown keys, so asking for
   one fails silently). `worker/test/reset.ts` resets explicitly and worker
   test files run one at a time.
7. **Everything that must be atomic goes through `db.batch()`.** D1 cannot hold
   a transaction across statements. That covers seating a table, a turn with
   its damage grid, and a double kill whose two placements are one fact.
8. **`worker/events.ts` is where every write path signals the display.** It is
   a no-op until phase 3 wires the Durable Object to it. Add the call there, not
   at each save, or the next save added will be the one that forgets and the
   projector will silently stop updating mid-game.

Four fixture gates keep the two halves honest, all run by pytest:
`fixture_expected.py` (scoring), `results_csv_fixture.py` (both exports, byte
for byte), `entry_rules_fixture.py` (61 rule cases) and
`tests/test_aggregate_parity.py` (the aggregation SQL and the stat field lists).

Run all three suites: `pytest -q`, `npx vitest run`, `npx tsc -b`.

**Phase 3 is done.** `/display/stream` is SSE again, fanned out by the `Board`
Durable Object (`worker/board-do.ts`); `worker/events.ts` renders the board once
per save and pushes it. Two rules that are easy to break by tidying:

9. **Never await a write to a subscriber's stream.** A `TransformStream`'s
   readable side has a highWaterMark of 0, so `write()` does not resolve until
   something reads the other end. Awaiting the first one deadlocks every
   connection, because the stream is the body of a `Response` that has not been
   returned yet; awaiting in the publish path lets one idle screen hold up the
   save that triggered it.
10. **Every line of an SSE frame needs its own `data:` prefix.** The payload is
    multi-line HTML, and without it everything after the first newline is
    dropped: the board arrives truncated to its opening `div`.

Phases 4 and 5 are not started: the offline fallback, and GitHub
(`git@github.com:mark-iid/commander.git`). The Python app in `app/` still
serves the event and still would for one booked before the cutover.

## Decisions already made (do not relitigate — see docs/adr/0001)

- **Backend:** FastAPI + HTMX. Server-rendered partials, minimal JS. *(Superseded by ADR 0003; still what runs today.)*
- **Storage:** SQLite now, Postgres-ready. *(Superseded by ADR 0003: D1, not Postgres. The repository boundary still holds while the Python app runs.)* All DB access goes through `app/repository.py` (a `Storage` protocol). Never write raw SQL outside the repository layer — that's what keeps the Postgres swap a config change.
- **Real-time:** Server-Sent Events (SSE), not polling. Leaderboard and standings push updates when an entry is saved. See `app/events.py`.
- **Concurrency:** Two pods, two trackers entering simultaneously, plus a projected public leaderboard. SQLite in WAL mode. Three surfaces: tracker entry, admin/config, public display.
- **Deployment:** Internet-reachable via Cloudflare Tunnel. *(Superseded by ADR 0003; the LXC deployment still serves the next event if one is booked mid-port.)* So auth is required — session-based passcode on tracker + admin routes; public leaderboard may be open. Cloudflare Access in front is a recommended second layer. Never assume LAN trust.
- **Config-driven:** Prizes, scoring, and roster live in `config/event.yaml`. The scoring engine reads prize definitions from config; adding a prize should be a YAML edit, not a code change.

## The domain in one screen

The app records **one row per player per turn cycle** (`turn_stats` + `turn_damage`), plus a small per-game section (`game_player_stats`: placement, final life, total graveyard) filled in when a player is out. Combat damage is stored **per opponent**. See `docs/DATA_MODEL.md` for the full schema and the prize→field mapping.

This replaced the original "one record per player per game" design on 2026-09-11 — see `docs/adr/0002`, which supersedes that part of ADR 0001. The short version: placement was required on every save, so a tracker could not record anything mid-game, and the event owner's tracking sheet turned out to be turn-shaped with per-opponent damage columns. `app/scoring.py` did **not** change: the repository aggregates turns back into the `GamePlayerStat` it already consumes (`_DERIVED_STATS`), which is the only place the two granularities meet. Keep it that way.

**Vocabulary (they are different things now):** a **match** is one of the night's games, `games.match_no`, 1..`games_per_player`. A **round** is one turn cycle inside a match, `turn_stats.round_no`. `games.round` used to mean the match number and was renamed for exactly this reason.

Players may bring a **different commander to each match**, recorded in `match_commanders`, keyed `(event, player, match)` rather than on `game_seats` — every match deals the pods and seats again, and a reseat rewrites a table's seat rows wholesale. `players.commander` is now only the roster default that pre-fills the form. Nothing in `app/scoring.py` reads any of it: commander damage travels with the person, not the deck (2026-11-14).

Two things about the entry surface worth knowing before touching `routes/entry.py`. A turn that credits `opps_eliminated` raises a **"who went out" form** above the turn form, one row per death, deriving each placement from the order of the rows (`_finishing_order`) instead of asking for it — it is derived from the turns on every render, so a reload keeps it and recording the deaths removes it. And every numeric box in the turn form **autosaves** to `POST /entry/turn/draft` as it is left, so jumping to another player mid-turn no longer discards what was typed; the draft deliberately skips the cross-field rules a half-typed turn breaks innocently, leaving the Save button the gate the finished row goes through and the only thing that advances the tracker.

The peaks (`biggest_attack_dealt`, `biggest_attack_taken`, `most_creatures_in_attack`) are **derived**, never entered. `total_graveyard` replaced `peak_graveyard` — it is a count of the pile at death or win, not a running maximum.

Scoring rules (confirmed with the event owner):
- Round-robin, 3 games each. Placement points: 1st=4, 2nd=3, 3rd=2, 4th=1. Win Points = sum across games.
- Placement = order of elimination; simultaneous deaths ranked by life-at-death (least negative higher); game-on-time ranked by current life; a tie takes the **better** of the placements it occupies and each tied player gets its full score (two tied over 3rd and 4th both finish 3rd, nobody finishes 4th).
- Technical Winner = most Win Points (tie: most combat damage). Blame It On Shuffling = fewest (tie: least combat damage).
- Every prize has a tiebreak, set by the event owner in the 2026 event notes (2026-11-11); the table is in `docs/DATA_MODEL.md`. Does Nobody Block? breaks on creatures attacked with over the whole night, which replaced a single-attack rule from 2026-10-23. A tie that survives the tiebreak goes to roster order.
- Jesse (the organiser) plays but cannot win prizes: `scoring.prize_ineligible` in config, and each prize he would win goes to the runner-up. He stays in the standings.

**Tiebreaker — decided 2026-08-06, no longer open:** `total_damage` is **combat damage dealt to players only**. Non-combat damage (burn, pingers, drains) is excluded — the event owner's call. Commander damage is excluded from the list because it *is* combat damage and is already counted inside `combat_dmg_dealt`: the format rules eliminate a player at "21 points of combat damage by a particular Commander" (<https://mtgcommander.net/index.php/rules/>), so listing it separately would double-count. See `total_damage_fields` in config and "What counts as damage" in `docs/DATA_MODEL.md`.

## Layout

```
app/
  main.py         FastAPI app; mounts routes, static, templates
  config.py       loads config/event.yaml into typed objects
  db.py           SQLite connection (WAL); applies schema.sql
  repository.py   Storage protocol + SQLiteStorage impl (the ONLY SQL)
  scoring.py      pure functions: standings + leaderboard from stats + config
  events.py       SSE broadcaster (in-process pub/sub)
  models.py       pydantic models / dataclasses
  routes/
    entry.py      seating + turn form + death/win form
    admin.py      roster / games / config admin
    display.py    public leaderboard + SSE stream
  templates/      Jinja2 + HTMX partials
  static/
config/
  event.example.yaml   copy to event.yaml to run
docs/
  DATA_MODEL.md        schema + prize mapping
  adr/0001-architecture-decisions.md
  adr/0002-turn-level-granularity.md   supersedes 0001 on granularity
tests/
  helpers.py           seat/record helpers; use these rather than hand-building forms
  test_scoring.py      verified against a known 4-player/3-game sample
```

## Build order (suggested)

1. `scoring.py` + `tests/test_scoring.py` already exist and pass — this is the verified core. Start here; everything else serves it.
2. `db.py` + `repository.py`: implement `SQLiteStorage` against `schema.sql`. Keep the `Storage` protocol clean so a `PostgresStorage` could drop in.
3. `routes/entry.py` + entry templates: seat the table, then a turn form (per-opponent damage grid) and a separate death/win form. HTMX POSTs write `turn_stats`/`turn_damage` or `game_player_stats`.
4. `events.py` + `routes/display.py`: on save, broadcast; SSE pushes the recomputed leaderboard partial to the public display.
5. `routes/admin.py`: roster + game setup + config view.
6. Auth: session passcode middleware on entry/admin. Document Cloudflare Access setup in README.

## Conventions

- Python 3.12+, type hints everywhere, `ruff` for lint/format.
- Pure logic (scoring) stays free of I/O and framework imports so it's unit-testable — keep it that way.
- No secrets in the repo. Passcode + config path via env (`.env`, see `.env.example`).
- Tests must pass before a feature is "done": `pytest`.
```
