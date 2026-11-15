# CLAUDE.md — Commander Tracker

## What this is

Stat tracker and prize leaderboard for a recurring Magic: The Gathering
Commander (EDH) tournament night. Cloudflare Workers + Hono + D1, server-rendered
partials over htmx, SSE to a projected board. Roster, scoring and prizes are
rows in the database.

Read `README.md` for the surfaces and `docs/DATA_MODEL.md` for the schema, the
prize-to-field mapping and the placement rules.

## Constraints that are not obvious from the code

- **Stat field names are part of the configuration format.** A prize refers to
  `combat_dmg_dealt` by that string. Renaming the property breaks existing event
  configurations, and silently: an unknown metric reads as zero for everyone,
  which renders as an unclaimed prize rather than an error.
- **`shared/scoring.ts` does no I/O.** Rows and configuration in, standings out.
- **SQL belongs in `worker/data.ts`, `worker/entry-data.ts`,
  `worker/admin-data.ts` and `shared/aggregate.ts`.**
- **Never edit an applied migration.** Add `000N_*.sql`.
- **Anything all-or-nothing goes through `db.batch()`.** D1 cannot hold a
  transaction across statements: seating a table, a turn with its damage grid, a
  double kill whose two placements are one fact.
- **Never await a write to a subscriber's stream** (`shared`/`worker/board-do.ts`).
  A `TransformStream`'s readable side has a highWaterMark of 0, so `write()`
  does not resolve until something reads the other end; awaiting the first write
  deadlocks every connection.
- **Every line of an SSE frame needs its own `data:` prefix.** Multi-line HTML
  payload; without it the board truncates to its opening `<div>`.
- **`worker/events.ts` is the single place every write path signals the display.**
- **Nothing may assume a single long-lived process.** Workers isolates do not
  share memory and are recycled, which is why the subscriber set is a Durable
  Object and the login throttle is a D1 table.

## Testing

```bash
npx tsc -b && npx vitest run
```

Two projects: `shared/**` in Node over `node:sqlite`, `worker/**` inside workerd
with a real D1 from `migrations/`. D1 storage is not rolled back between tests;
`worker/test/reset.ts` does it explicitly and worker files run one at a time.

`shared/fixtures/` holds a recorded event with pseudonymous names in the original
roster order. The tests compare against its recorded standings, prize winners and
CSV exports. Changing scoring means changing the fixture deliberately.

After writing a test, break the code and check the test notices.

## Deployment

Workers Builds on a push to `main`. Cloudflare resources are on the Mystikos
account, not the default one wrangler may be logged into; run
`npx wrangler whoami` and confirm before creating anything.

## Known gaps

- No offline fallback. The app needs a network, which a venue may not have.
- `mtg.earnestdesigns.com` is configured as the custom domain. As of 2026-11-15
  the Workers custom domain is attached and the dashboard shows a Worker DNS
  record, but the authoritative nameservers serve no address for it, so the
  hostname does not resolve. The app itself is deployed and serving.
