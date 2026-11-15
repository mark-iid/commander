# Moving to D1

Phase 1 of [ADR 0003](adr/0003-cloudflare-workers-port.md): the schema and the
existing night move to Cloudflare D1. There is no Worker yet, so nothing here
changes how the app is served. The LXC deployment still runs the FastAPI app and still
serves an event if one is booked before phase 2 lands.

What exists after phase 1: a schema, a way to apply it, a way to carry the
2026-11-14 night across, and tests proving the night scores identically on the
other side.

## One-time setup

```bash
npm install
npx wrangler d1 create commander-tracker
```

That prints a `database_id`. Paste it into `wrangler.jsonc`, replacing
`PLACEHOLDER`. It is not a secret and belongs in the repo; `utilization` keeps
its own the same way.

Until it is filled in, only `--local` works, which is enough for everything
below except shipping.

## Applying migrations

```bash
npx wrangler d1 migrations apply commander-tracker --local    # a local copy
npx wrangler d1 migrations apply commander-tracker --remote   # the real one
```

Wrangler tracks what it has applied in a `d1_migrations` table, so both are
safe to re-run. Migrations are numbered files in `migrations/`; the next one is
`0002_*.sql`. Never edit a migration that has been applied remotely: add
another.

## Carrying the existing night across

`scripts/export_for_d1.py` reads a live database and its config and writes SQL.
It opens the database read-only and talks to nothing.

```bash
python3 scripts/export_for_d1.py \
    --db /var/lib/commander-tracker/commander.db \
    --config /opt/commander-tracker/config/event.yaml \
    --out import.sql
```

Both paths are on the deployment host, and the config matters as much as the database: the
prizes, placement points and damage fields have only ever lived in the YAML, and
that YAML is excluded from deploys, so the copy in the repo is not it.

Read `import.sql` before running it. Then:

```bash
npx wrangler d1 execute commander-tracker --local --file=import.sql
npx wrangler d1 execute commander-tracker --remote --file=import.sql
```

Two things the exporter refuses rather than guesses at:

- **A `prize_ineligible` name matching nobody on the roster.** The quiet version
  of that mistake is the organiser becoming eligible for prizes again.
- **A database holding more than one event.** The old app only ever served one,
  so a file with several was not written by it.

And one thing worth knowing: **players come from the database, not the config.**
`roster:` seeds the players table once, when the event row is first created, and
`/admin` owns it after that. On the real night the YAML still read
Player6/Player7/Player8 while the database had the names people played under.

## What changed in the schema

The migration's own comments say, column by column. The short version:

- Event configuration is in the database, not `config/event.yaml`. A second
  tournament is a row rather than a redeploy, and the trap where a renamed
  scoring field left every prize silently unclaimed cannot happen.
- `players.prize_eligible` replaces `scoring.prize_ineligible`. A flag on the
  person survives a rename; a list of names does not.
- `players.roster_position` is explicit, because roster order is the scoring
  engine's last-resort tiebreaker and must survive an admin edit.
- `placement` is `CHECK (>= 1)`, not `BETWEEN 1 AND 4`. `pod_size` was already
  configurable and the old constraint contradicted it.
- Pods are rows, so a pod can be called "Table 1".

Nothing the aggregation query touches was renamed, which is why
`app/repository.py` can read the new tables unchanged.

## How this is tested

| Gate | What it holds |
|---|---|
| `shared/schema.test.ts` | Applies the migration to a throwaway database, loads the golden fixture, runs the aggregation, and requires every derived row, standing and prize winner to match what the Python app produced. Also covers the constraints the old schema lacked. |
| `tests/test_export_for_d1.py` | The same claim through the exporter: old schema, `export_for_d1.py`, new schema, scoring. Plus the refusals above, and that an apostrophe in a deck name survives. |
| `tests/test_aggregate_parity.py` | The aggregation SQL is the same text in `app/repository.py` and `shared/aggregate.ts`. Two copies exist until phase 2 deletes the first. |

`npx vitest run` and `pytest -q`. Neither needs a Cloudflare account: the
TypeScript side uses `node:sqlite`, which speaks the same dialect D1 does.

The path was also run end to end against the real 2026-11-14 database and
against local D1 through wrangler, both producing results identical to what the
live app computed. Those runs are not in CI, because the fixture covers the same
ground without a network or an account. To repeat the wrangler half:

```bash
npx wrangler d1 migrations apply commander-tracker --local
npx wrangler d1 execute commander-tracker --local --file=import.sql
```
