# Commander Tracker

A real-time stat tracker and novelty-prize leaderboard for a recurring Magic: The
Gathering Commander (EDH) tournament night. Players compete across several games,
trackers record per-turn stats on their phones, and a projected leaderboard awards
about a dozen novelty prizes live. Prizes, scoring and roster are data, so running
a different event is a configuration change rather than a code change.

It has been used for a real event. Everything in here is shaped by that rather
than by what looked tidy: forms that fit one phone screen because a tracker saves
forty of them a game, boxes that keep what was typed because somebody has to jump
away mid-turn to record a death, and a projected board that says when its own feed
has died.

## There are two apps in here, and that is deliberate

The project is being ported from a self-hosted Python app to a Cloudflare Worker,
in phases, and the repository holds both halves while that finishes. See
[ADR 0003](docs/adr/0003-cloudflare-workers-port.md) for why and what order.

| | |
|---|---|
| `worker/` | **Where the work is going.** Hono on Cloudflare Workers over D1, with the live board pushed from a Durable Object. All four surfaces are ported. |
| `app/` | **What still serves the event today.** FastAPI + HTMX over SQLite. Being retired, not maintained in parallel for its own sake. |
| `shared/` | The scoring engine and the aggregation query, used by both. |

Neither half is allowed to drift from the other. Four gates in the pytest suite
compare them: the scoring results, both CSV exports byte for byte, 61 entry-rule
cases, and the aggregation SQL itself. Change one side and the other side's tests
fail until it follows.

## Stack

- **Cloudflare Workers + Hono**, server-rendered partials over HTMX, minimal JS
- **D1** (SQLite) with numbered migrations
- **Server-Sent Events** for the live board, fanned out by a **Durable Object**
- Shared-passcode session auth on the tracker and admin surfaces
- The half being retired: FastAPI + HTMX over SQLite in WAL mode

## Quickstart

### The Worker

```bash
npm install
npx wrangler d1 create commander-tracker     # paste the id into wrangler.jsonc
npx wrangler d1 migrations apply commander-tracker --local
cp .dev.vars.example .dev.vars               # set TRACKER_PASSCODE and SESSION_SECRET
npx wrangler dev
# entry:    http://localhost:8787/entry
# admin:    http://localhost:8787/admin      (add players here first)
# display:  http://localhost:8787/display    (project this)
# results:  http://localhost:8787/results
```

A fresh database has no event in it, so the surfaces answer 503 until one exists.
[`docs/D1_MIGRATION.md`](docs/D1_MIGRATION.md) covers creating one, and carrying an
existing SQLite database across.

### The app being retired

```bash
# Python 3.12+
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

cp config/event.example.yaml config/event.yaml
cp .env.example .env        # set TRACKER_PASSCODE, etc.

uvicorn app.main:app --reload --workers 1
```

### Tests

```bash
ruff check . && pytest -q    # the Python half, plus the four cross-checks
npx tsc -b && npx vitest run # the Worker, inside workerd against a real D1
```

Neither needs a Cloudflare account or a network: the Worker tests build their D1
from `migrations/`, and the Python-side schema tests use `node:sqlite`, which
speaks the same dialect.

## CI

Every push and every pull request runs lint, both test suites and the typecheck:
[`.github/workflows/ci.yml`](.github/workflows/ci.yml). Reproduce it in four
commands:

```bash
pip install -e ".[dev]" && ruff check . && pytest -q
npm ci && npx tsc -b && npx vitest run
```

`ruff check .` takes no arguments by design: the rule set is pinned in
`pyproject.toml`, so it gives you the same answer it gives CI. `ruff` is pinned to
a minor range in the `dev` extra, so a new release cannot turn the pipeline red on
its own.

Two things to know if an install behaves oddly. `npm ci` needs the `allowScripts`
entries in `package.json`: npm 11 blocks package install scripts by default, and
without those entries the Workers runtime is not installed and the vitest step
fails on a missing binary. A dependency bump re-blocks them deliberately, so
`npm install-scripts approve <pkg>` is part of reviewing one.

There is no `ruff format --check`. Adopting the formatter would reformat the
verified scoring core, which is a decision to take on its own merits rather than a
side effect of adding CI.

No deploy job here. The Worker is deployed by Cloudflare Workers Builds, which
watches this repository directly; the Python app is deployed from the maintainer's
own Forgejo instance (`.forgejo/`), which is also where a `HOLD` file at the repo
root stops a deploy without needing a revert. Worth doing before an event,
because otherwise a merge restarts the app under the trackers mid-game.

## Surfaces

- **/entry** — trackers seat the table, note which commander each player brought to the
  match, then record one row per player per turn cycle (two pods, concurrent). Each box is
  kept as it is left, so jumping to another player mid-turn costs nothing; a turn that
  eliminates somebody asks who went out, one row per death, and works out the placements
  from the order.
- **/admin** — roster, game setup, config.
- **/display** — read-only public leaderboard, SSE-updated live. Meant for a projector.
- **/results** — the take-home sheet: standings, awards and every game, laid out for paper.

## Results and exports

`/results` is the record of a night — standings, every award and its winner, and a
game-by-game breakdown. It describes **whatever has been recorded so far**, so the same URL
is a snapshot after round one and the final results after round three. The header says
which: it reads *Final results* only once every rostered player has every game recorded, and
*Provisional* with a count otherwise. A sheet that cannot tell you how much of the night it
covers is worse than no sheet.

- **PDF** — the *Save as PDF* button opens the browser's print dialog; choose "Save as PDF"
  as the destination. The page carries `@media print` rules that invert it to black on
  white, drop the navigation, and keep games from splitting across a page break. No PDF
  library is involved, which is why the sheet still looks like the event.
- **CSV** — *Download CSV* gives one row per player per game with every derived stat as a
  column, plus the commander they brought to that match, sorted by match, pod then
  placement so two exports of the same data are byte-identical.
- **Turns CSV** — *Download turns CSV* gives one row per player per **turn**, with a damage
  column per rostered player. This is the granularity the app actually records, and the
  per-game CSV aggregates it away. A damage cell is blank where that player was not at the
  table (or is the player themselves) and `0` where they were and took nothing — a single
  zero for both would lose the difference.

Each game on the sheet also carries a **damage matrix**: rows are damage dealt, columns
damage taken, with both margins totalled. It exists only because combat damage is stored per
opponent, and the tallest *Taken* figure is the match's archenemy — something no per-game
total could ever have shown. A match where nobody connected omits the grid rather than
printing a wall of zeros.

The game-by-game table prints eleven columns, so its headings are abbreviated (`Combat`,
`Non-cbt`, `Big taken`…) with a legend above expanding each one. A new stat field therefore
needs a `short` heading in `GAME_STAT_FIELDS` — `tests/test_results.py` fails without one.

Unlike `/display`, `/results` is **always behind the passcode**, whatever `protect_display`
says: the CSV carries per-game rows for named people, which is a step past the standings the
room can already see.

## Data model in one line

One record per player per game (`game_player_stats`). Every prize is a per-game total or
per-game peak — no turn-by-turn data. Full schema and prize→field mapping in
[`docs/DATA_MODEL.md`](docs/DATA_MODEL.md). Architecture rationale in
[`docs/adr/0001-architecture-decisions.md`](docs/adr/0001-architecture-decisions.md).

## Configuring an event

**On the Worker, the configuration is rows in the database, not a file.** Prizes,
placement points, damage fields, pods and the roster all live in D1 and are edited
at `/admin`, so a second tournament is a row rather than a redeploy. That also
removes the worst trap the file had: `config/event.yaml` was excluded from deploys,
so a renamed scoring field left every prize silently unclaimed, with no error and
no log line. `config/event.example.yaml` is still the clearest description of what
a prize is, and `scripts/export_for_d1.py` turns a YAML config and an existing
database into the rows.

The rest of this section describes the file, which is how the half being retired
reads its configuration.

Edit `config/event.yaml`: roster, `placement_points`, and the `prizes` list. The scoring
engine is generic — a prize is `{metric, agg (max/min), scope (night/peak), optional tiebreak}`.
Adding "Most Creatures Killed" is a YAML entry plus a column, not a rewrite.

**The `roster:` list seeds a brand-new event only.** It is read once, when the event row is
first created, and ignored on every startup after that — `/admin` owns the roster from then
on. This is deliberate: the sync is insert-only, so re-running it would resurrect players an
admin had deleted. On an existing database, editing `roster:` and restarting does nothing;
add and rename players at `/admin`. Everything else in the file is re-read on each request
and stays live.

## Resetting between events (or after a rehearsal)

Two levels, available two ways.

| | Deletes | Keeps |
|---|---|---|
| **Clear all results** | every game and stat row | the roster |
| **Reset everything** | results *and* the roster | the event; roster is rebuilt from `event.yaml` |

### From the app

`/admin` → **Danger zone**. Clicking a reset button only *arms* it: the panel swaps to a
confirmation naming the real counts ("this permanently deletes 24 stat rows across 6 games")
and, for a full reset, the roster it will restore. Nothing is deleted until you confirm.
Arming is a GET that changes nothing, so a refresh or a double-click cannot destroy data.

A completed reset publishes on the event bus, so the projected leaderboard clears itself —
no need to touch the display machine.

### From the command line

`scripts/reset.py` does the same two things, and still works when the app won't start. It
reads `DB_PATH` and `EVENT_CONFIG` from `.env`, so run it from the install directory and it
finds the live database.

```bash
python scripts/reset.py                 # status only: which database, roster, rows recorded
python scripts/reset.py --results --yes # delete every game and stat; keep the roster
python scripts/reset.py --all --yes     # also drop the roster and reseed it from event.yaml
```

Nothing is deleted without `--yes`; without it the script prints the plan.

### Both paths

A backup lands in `backups/` beside the database before anything is deleted, taken through
SQLite's backup API so it is consistent even while the service is writing. The CLI can skip it
with `--no-backup`; the admin surface cannot, and refuses to delete anything if the backup
fails.

Both levels are safe to run against a running server. The event row is kept precisely so the
cached `event_id` stays valid and nothing needs restarting — that is why a full reset reseeds
the roster instead of deleting the event and letting startup rebuild it.

A reset is the *only* thing that re-reads `roster:` from config, which is what makes it the way
to clear out test players. One caveat for the CLI: it is a separate process, so a `/display`
tab already on screen will not hear about it — reload that tab. Resetting from `/admin` pushes
to the display on its own.

Deleting players by hand instead? `/admin` refuses to delete a player who has stats recorded,
so clear the results first and they become removable.

## Deployment

### The Worker

Deployed by [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/),
which watches this repository and runs `wrangler deploy` on a push to `main`. The
one-time setup is in the Cloudflare dashboard: connect the repository, and set
`TRACKER_PASSCODE` and `SESSION_SECRET` as secrets on the Worker.

```bash
npx wrangler d1 create commander-tracker     # once; paste the id into wrangler.jsonc
npx wrangler d1 migrations apply commander-tracker --remote
npx wrangler secret put TRACKER_PASSCODE
npx wrangler secret put SESSION_SECRET
```

`wrangler.jsonc` carries the rest: the D1 binding, the Durable Object the SSE
fan-out lives in, the static assets, the hostname, and `EVENT_TIMEZONE`, which is
the room's clock. That last one matters more than it sounds: a Worker has no local
timezone, so without it an evening download of the results would be stamped with
the next day's UTC date on the one artefact people keep.

`workers_dev` is off, so the app answers on its own hostname only. A second public
front door is a second thing to remember to gate.

### The app being retired

Run it behind a `cloudflared` tunnel on a Linux box:

```bash
cloudflared tunnel create commander
cloudflared tunnel route dns commander tracker.example.org
# ingress -> http://localhost:8000
cloudflared tunnel run commander
```

**Exactly one uvicorn worker.** Its SSE broadcaster is in-process, so a second
worker silently drops live updates for every client attached to the other process.
That constraint is the single biggest reason for the port: see
[ADR 0003](docs/adr/0003-cloudflare-workers-port.md).

Because either way it is internet-reachable:
- Session passcode auth guards `/entry`, `/admin` and `/results`.
- Strongly consider **Cloudflare Access** (Zero Trust) in front as a second layer.
- Gate `/display` too unless you want the standings publicly visible.

### Auth

One shared passcode, exchanged for a signed session cookie — no user accounts (ADR 0001,
decision 6). Set it in the environment; it never goes in `event.yaml`:

```bash
TRACKER_PASSCODE=...       # required — the app refuses to start without it
SESSION_SECRET=...         # required — python -c "import secrets;print(secrets.token_hex(32))"
```

**The app will not start if either is unset or left as `change-me`.** That's deliberate: a
silently unauthenticated `/entry` is exactly the failure this guards against.

Policy lives in `config/event.yaml`:

```yaml
auth:
  protect_display: false   # true also gates the projected leaderboard
  session_hours: 12        # how long a tracker stays signed in
  secure_cookies: false    # true once served over HTTPS via the tunnel
```

Sign in at `/login`; `/entry` and `/admin` redirect there and return you to where you were
headed. Five wrong guesses locks that client out for 60s. When you put this behind the
tunnel, set `secure_cookies: true` and consider `protect_display: true`.

## Emergency: running it on a laptop

> **This covers the half being retired, not the Worker.** It runs the FastAPI app
> in a container with no network at all, which is the one thing a Worker cannot do.
> There is no equivalent fallback for the Worker yet, and that is a known gap
> rather than an oversight: see phase 4 in
> [ADR 0003](docs/adr/0003-cloudflare-workers-port.md).

The host, the tunnel, the house internet and DNS can all fail on a Friday night, and none of
them can be fixed from a games table. `scripts/emergency.sh` is the fallback for all four: the
whole app in one container on a laptop in the room, serving the phones already on the wifi.

```bash
./scripts/emergency.sh prepare   # before the night, on a connected machine: builds the
                                 # image AND saves it to a tarball
./scripts/emergency.sh start     # on the night: no registry, no pip, no network needed
```

`start` prints the four surface URLs for this machine, the same URLs at its LAN addresses to
hand to the trackers, and the passcode. The event config, the database and the backups live in
`~/commander-tracker-emergency`, bind-mounted into the container, so stopping or rebuilding
never costs a night's results. `status`, `logs`, `backup`, `stop` and `seed` do what they say.

Full runbook — what to do before the night, what the fallback cannot do, and how to keep the
results afterwards — in [`docs/EMERGENCY.md`](docs/EMERGENCY.md).

## Status

The app works and has run a real event. What is in progress is the move off
self-hosting, in the phases [ADR 0003](docs/adr/0003-cloudflare-workers-port.md)
sets out:

| Phase | | |
|---|---|---|
| 0 | Scoring engine ported to TypeScript, verified against the real night | done |
| 1 | Schema as D1 migrations, multi-event, the existing night imported | done |
| 2 | The Worker: entry, admin, display and results | done |
| 3 | The live board over SSE, fanned out by a Durable Object | done |
| 4 | An offline fallback for the Worker | not started |
| 5 | GitHub, Workers Builds, docs for a stranger | in progress |

The Python app still serves the event until the Worker is deployed and has run
one. Until then both halves are kept green, and the cross-checks in the pytest
suite are what make that cheap rather than a matter of discipline.

`/display` is a standalone kiosk surface styled after the Norton Simple theme, meant to be
projected. It renders server-side on load and receives a re-rendered board over SSE on every
save — no polling, no client-side scoring. The status bar shows the live connection state, so
a dead feed is visible in the room rather than silently frozen.

**On the retired half, the SSE broadcaster is in-process: run exactly one worker.**
A second worker silently drops live updates for clients attached to the other
process. On the Worker the subscriber set lives in a Durable Object, which is what
made that constraint go away.

### If you are touching `app/templates/`

Its pages link assets through an `asset()` helper that appends a hash of the
file's contents, because that app is served through a Cloudflare Tunnel and the
edge caches `/static` for four hours — and `/display` is the one screen nobody
reloads. `tests/test_assets.py` fails the build if a page links a bare `/static/…`
path. The Worker does not need this: Workers Assets answers with a content ETag
and `must-revalidate` instead.

## License

Apache License 2.0 — see [LICENSE](./LICENSE).

Third-party assets vendored into `app/static/`: htmx and its SSE extension, both
[zlib-licensed](https://github.com/bigskysoftware/htmx/blob/master/LICENSE).
