# Commander Tracker

Stat tracker and prize leaderboard for a Magic: The Gathering Commander (EDH)
tournament night. Trackers record per-turn stats from their phones, a projected
board shows standings and prize winners and updates on every save, and the
night's results export as CSV.

Runs on Cloudflare Workers with D1. Roster, scoring and prizes are rows in the
database, not code.

## Surfaces

| Path | Auth | Purpose |
|---|---|---|
| `/entry` | passcode | Seat a table, record turns, record deaths and wins |
| `/display` | open by default | Projected standings and prize board, live over SSE; click a prize for its full ranking |
| `/results` | passcode | Printable results sheet |
| `/results.csv` | passcode | One row per player per game |
| `/results/turns.csv` | passcode | One row per player per turn, damage per opponent |
| `/admin` | passcode | Events, roster, prize eligibility, reset |

`/entry`, `/display` and `/admin` work on the active event. The three results
paths take `?event=<id>` for any event and default to the active one.

## Stack

- Cloudflare Workers, [Hono](https://hono.dev), server-rendered partials over [htmx](https://htmx.org)
- D1 for storage, with numbered migrations in `migrations/`
- A Durable Object for the SSE fan-out to the projected board
- One shared passcode exchanged for a signed session cookie

## Running it locally

```bash
npm install
npx wrangler d1 create commander-tracker     # paste the id into wrangler.jsonc
npx wrangler d1 migrations apply commander-tracker --local
cp .dev.vars.example .dev.vars               # set TRACKER_PASSCODE and SESSION_SECRET
npx wrangler dev
```

Every surface, `/admin` included, answers 503 until an event exists in the
database. The first one has to be inserted directly (the tables are listed
under Configuring an event). After that, `/admin` creates new events by copying
an existing one.

The app refuses to serve `/entry`, `/admin` and `/results` while either secret
is unset or still `change-me`.

## Tests

```bash
npx tsc -b
npx vitest run
```

Two projects. `shared/**` runs in Node and uses `node:sqlite`, which speaks the
same dialect as D1, so the schema and the scoring engine are tested without a
runtime. `worker/**` runs inside workerd with a real D1 built from
`migrations/`. Neither needs a Cloudflare account or a network.

`shared/fixtures/` holds a recorded event: 8 players, 2 pods, 3 matches, 156
turn rows, with the players' names replaced. Names are replaced in roster order,
because roster order is the scoring engine's last tiebreaker. The tests compare
against its recorded standings, prize winners and CSV exports.

If `npm ci` leaves the Workers runtime uninstalled, it is the `allowScripts`
entries in `package.json`: npm 11 blocks package install scripts unless they are
listed, and a dependency bump re-blocks them.

## Events

Each tournament is an event. `/admin` lists them and can:

- create one, copying pods, placement points, damage fields and prizes from an
  existing event, and optionally its roster. Results are never copied.
- rename one or set its date
- make one active. The display reloads onto it.
- delete one, after a confirmation that shows its counts. The active event
  cannot be deleted. A D1 restore point is recorded first.

There is no editor for prizes or scoring; a new event inherits them from the
one it copies.

## Configuring an event

Per event, in the database:

| Table | Holds |
|---|---|
| `events` | name, date, matches per player, pod size |
| `pods` | the concurrent tables, labelled |
| `players` | roster, in order, with prize eligibility per player |
| `placement_points` | finishing position to win points |
| `total_damage_fields` | which stat fields sum into the damage tiebreaker |
| `prizes` | each prize's metric, aggregation, scope and tiebreak |
| `active_event` | which event the unqualified surfaces mean |

A prize is `{metric, agg (max|min), scope (night|peak), tiebreak}`. `metric` is
a stat field name or `win_points`. `scope: night` sums a player's games,
`scope: peak` takes their single best. Adding a prize is a row.

Field names are part of the configuration format: a prize refers to
`combat_dmg_dealt` by that string. An unknown metric reads as zero for every
player, which renders as a prize nobody has won rather than an error.

Prize eligibility is a flag per player. An ineligible player scores and appears
in the standings; each prize they would have won goes to the runner-up.

## Scoring

Placement points sum across a player's games to give win points. The damage
tiebreaker is combat damage dealt to players, and excludes non-combat damage.
Commander damage is excluded from that sum because it is already counted inside
combat damage.

Placement is the order of elimination. Simultaneous deaths rank by life at
death, least negative higher. Tied players take the better of the placements
they occupy and each gets its full score, so two tied over 3rd and 4th both
finish 3rd and nobody finishes 4th.

`docs/DATA_MODEL.md` has the schema, the prize-to-field mapping and the full
placement rules.

## Deployment

Deployed by [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
on a push to `main`. One-time setup:

```bash
npx wrangler d1 create commander-tracker     # paste the id into wrangler.jsonc
npx wrangler d1 migrations apply commander-tracker --remote
npx wrangler secret put TRACKER_PASSCODE
npx wrangler secret put SESSION_SECRET
```

`wrangler.jsonc` carries the D1 binding, the Durable Object, the static assets,
the hostname, and:

| Var | Default | Means |
|---|---|---|
| `SESSION_HOURS` | `12` | How long a tracker stays signed in |
| `PROTECT_DISPLAY` | `false` | Whether the projected board needs the passcode |
| `EVENT_TIMEZONE` | `America/New_York` | The room's clock, for export filenames and the results sheet |

`EVENT_TIMEZONE` matters because a Worker has no local timezone: without it an
evening download is stamped with the next day's UTC date.

`workers_dev` is off, so the app answers on its own hostname only.

## Layout

```
worker/
  index.ts        routes, the passcode guard, static assets
  auth.ts         passcode sessions and the login throttle
  data.ts         event, configuration and derived-stat reads
  entry-data.ts   seating, turns, deaths and wins
  entry-rules.ts  finishing order, outstanding deaths, who is next up
  admin-data.ts   events, roster CRUD, result counts, resets
  board-do.ts     the Durable Object the SSE subscribers live in
  csv.ts          CSV writing and the export filenames
  routes/         one file per surface
  views/          hono/html templates
shared/
  scoring.ts      standings and prize winners; pure functions
  aggregate.ts    the SQL that turns turn rows into per-game stats
  fixtures/       a recorded event, used by the tests
migrations/       numbered D1 migrations
static/           stylesheets and vendored htmx
```

`shared/scoring.ts` takes rows and configuration and returns standings. It does
no I/O and imports no framework.

## License

Apache License 2.0, see [LICENSE](./LICENSE).

htmx and its SSE extension are vendored into `static/` and are
[zlib-licensed](https://github.com/bigskysoftware/htmx/blob/master/LICENSE).
