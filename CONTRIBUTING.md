# Contributing

## Running the tests

```bash
npm install
npx tsc -b
npx vitest run
```

Two vitest projects. `shared/**` runs in Node against `node:sqlite`, which
speaks D1's dialect. `worker/**` runs inside workerd with a real D1 built from
`migrations/`. Neither needs a Cloudflare account or a network.

If the vitest step fails on a missing binary, it is `npm ci` and install
scripts: npm 11 blocks them unless listed in `allowScripts` in `package.json`.
They are listed per version, so a dependency bump re-blocks them and
`npm install-scripts approve <pkg>` is part of reviewing it.

D1 storage is not rolled back between tests, and this plugin version has no
isolated-storage option. `worker/test/reset.ts` resets explicitly and worker
test files run one at a time.

## Constraints

- **Stat field names are part of the configuration format.** A prize refers to
  `combat_dmg_dealt` by that string, so renaming the property breaks existing
  event configurations. An unknown metric reads as zero for every player, which
  renders as an unclaimed prize rather than an error.
- **The scoring engine does no I/O.** `shared/scoring.ts` takes rows and
  configuration and returns standings. Keep it free of framework imports.
- **SQL belongs in the data modules**: `worker/data.ts`,
  `worker/entry-data.ts`, `worker/admin-data.ts`, and `shared/aggregate.ts` for
  the per-game aggregation.
- **Never edit an applied migration.** Add `000N_*.sql`. Wrangler records what
  it has applied by filename in a `d1_migrations` table.
- **Anything that must be all-or-nothing goes through `db.batch()`.** D1 cannot
  hold a transaction across statements. That covers seating a table, saving a
  turn with its damage grid, and a double kill whose two placements are one
  fact.
- **Never await a write to a subscriber's stream.** A `TransformStream`'s
  readable side has a highWaterMark of 0, so `write()` does not resolve until
  something reads the other end. Awaiting the first write deadlocks every
  connection, because the stream is the body of a `Response` that has not been
  returned. Awaiting in the publish path lets one idle screen hold up the save.
- **Every line of an SSE frame needs its own `data:` prefix.** The payload is
  multi-line HTML; without it the board arrives truncated to its opening
  `<div>`.
- **`worker/events.ts` is where every write path signals the display.** Add the
  call there rather than at each save site.

## Tests

New behaviour wants a test that fails without it. After writing one, break the
code on purpose and check the test notices. That has caught four tests in this
repository that passed against a deliberately broken implementation, including a
CSV writer whose quote escaping could be deleted because no field in the fixture
contained a quote.

## Style

TypeScript is `strict` and `npx tsc -b` must be clean. There is no formatter
check; match the surrounding code. Comments explain why, including what was
tried and rejected.
