# Contributing

This started as one person's tracker for one games night and grew into something
general enough to publish. Patches, bug reports and "I ran this for my own event
and here is what broke" are all welcome.

## Running it

Two suites, because the repository holds both halves of a port in progress (see
[ADR 0003](docs/adr/0003-cloudflare-workers-port.md)). Both have to pass.

```bash
pip install -e ".[dev]" && ruff check . && pytest -q
npm ci && npx tsc -b && npx vitest run
```

Neither needs a Cloudflare account or a network. The Worker tests run inside
workerd against a real D1 built from `migrations/`; the Python-side schema tests
use `node:sqlite`, which speaks the same dialect.

If the vitest step fails on a missing binary, it is `npm ci` and install scripts:
npm 11 blocks them unless they are listed in `allowScripts` in `package.json`.
They are listed, pinned to a version, so a dependency bump re-blocks them
deliberately. `npm install-scripts approve <pkg>` is part of reviewing that bump.

## The four cross-checks

The two halves are not allowed to drift. Four gates in the pytest suite compare
them, and all four live on the Python side because Python is the reference
implementation until the Worker takes over:

| | |
|---|---|
| `scripts/fixture_expected.py` | The scoring results over the real event |
| `scripts/results_csv_fixture.py` | Both CSV exports, byte for byte |
| `scripts/entry_rules_fixture.py` | 61 cases of the entry surface's rules |
| `tests/test_aggregate_parity.py` | The aggregation SQL, and the stat field lists |

Each has a `--check` mode that pytest runs and a `--write` mode that adopts a
change. The sequence when you change behaviour on purpose is: change the Python,
watch the gate fail, run `--write`, watch the corresponding TypeScript test fail,
then make it pass. What cannot happen is both suites green with the two halves
disagreeing, and that is the point.

## Things worth knowing before changing something

- **The scoring engine is the verified core.** `app/scoring.py` and
  `shared/scoring.ts` are held to the results of an event that actually happened,
  with every prize and tiebreak the event owner settled. Changing scoring means
  changing both and adopting the fixture deliberately.
- **Field names are part of the config format.** A prize says
  `metric: combat_dmg_dealt`, so renaming that property breaks every existing
  event config, and silently: an unknown metric reads as zero for everyone, which
  is a prize that never awards rather than an error.
- **Keep the scoring engine free of I/O.** It takes rows and config and returns
  standings. That is what makes it testable and what let the storage granularity
  change once already without touching it.
- **SQL lives in the data layer.** `app/repository.py` on the Python side,
  `worker/data.ts`, `worker/entry-data.ts` and `worker/admin-data.ts` on the
  other. The aggregation query itself is in `shared/aggregate.ts` and exists
  twice on purpose; the parity test holds the copies together.
- **Never edit an applied migration.** Add `000N_*.sql`. Wrangler tracks what it
  has applied.
- **Two rules about the live board** that are easy to break by tidying: never
  await a write to a subscriber's stream (a `TransformStream`'s readable side has
  a highWaterMark of 0, so it deadlocks), and every line of an SSE frame needs
  its own `data:` prefix (the payload is multi-line HTML).

## Tests

New behaviour wants a test that fails without it. Beyond that, one habit has
earned its place here: after writing a test, break the code on purpose and check
the test notices. It has caught four tests in this repository that passed against
a deliberately broken implementation, including a CSV writer whose quote escaping
could be deleted entirely because no field in the sample data contained a quote.

## Style

`ruff` for the Python, with the rule set pinned in `pyproject.toml` so
`ruff check .` gives you the same answer it gives CI. TypeScript is `strict`, and
`npx tsc -b` has to be clean. There is no formatter check; match what is around
you.

Comments here explain *why*, including what was tried and rejected. If you remove
one, remove the reason too, or put it somewhere better.
