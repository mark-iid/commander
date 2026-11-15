# 0003 — Port to Cloudflare Workers, verified against the real night

Date: 2026-11-15
Status: accepted, in progress. **Supersedes the backend, storage, real-time and
deployment decisions in [ADR 0001](0001-architecture-decisions.md)**: FastAPI +
HTMX, SQLite behind a `Storage` protocol, in-process SSE, and the
homelab-plus-Cloudflare-Tunnel deployment. The domain model in
[ADR 0002](0002-turn-level-granularity.md) is unaffected and carries over
whole. Phases 0 to 3 are done; phases 4 and 5 are not.

## Context

The app was built for one tournament night. That night happened on 2026-11-14,
it went well, and the event is now recurring, with the project heading for
GitHub as something other people could run. Three things followed from that and
together they changed the answer to a question that had already been settled
twice.

**The event is not held at the owner's house.** While it might have been, local
hosting was the *more* available option: an ISP outage would take out the
Cloudflare Tunnel and leave the trackers' phones still talking to the app over
the LAN. Held elsewhere, that inverts. The house becomes a remote dependency
for an event nobody at the venue can fix, and `docs/EMERGENCY.md` exists
precisely because that dependency is real.

**The deploy path was going away regardless.** Deploys ran from a Forgejo
runner living inside the deployment container itself. Moving the project to
GitHub ends that arrangement whatever the hosting, so "it already works, do not
touch it" stopped being an argument for staying.

**There are no migrations, and there have to be now.** `app/db.py` applies
`app/schema.sql` with `CREATE TABLE IF NOT EXISTS`, so it never alters an
existing table; ADR 0002 says outright "Migration. There is none." Every schema
change so far has meant deleting the database. A recurring event accumulates an
archive nobody can throw away, and an open-source user hits the same wall on
their second upgrade. Schema versioning was the next thing to build either way,
and D1 has it built in.

Against that, the costs are real and not small. It is a port of ~1,900 lines of
application Python and ~1,000 lines of templates, with 417 tests behind them.
SSE needs a Durable Object, because Workers isolates cannot broadcast to one
another. And the emergency podman kit does not survive a move to the one place
that cannot work without a network.

## Decision

Port to Cloudflare Workers with D1, in phases, with the riskiest part verified
first and in isolation.

The ordering is the decision, not an implementation detail. `app/scoring.py` is
the project's verified core: eleven novelty prizes, each with a tiebreak the
event owner confirmed, where a silent divergence costs an evening rather than
raising an error. So it goes first, on its own, held to the night it has to
reproduce.

| Phase | What |
|---|---|
| **0** | Port the scoring engine to TypeScript. Prove it against the real night. **Done.** |
| 1 | Schema as D1 migrations, with multi-event folded in. Import the existing database once. |
| 2 | The Worker: Hono routing for entry, admin, display and results. HTMX unchanged. |
| 3 | SSE over a Durable Object. **Done.** |
| 4 | Redesign the offline fallback. |
| 5 | GitHub (`git@github.com:mark-iid/commander.git`), Workers Builds, and docs written for a stranger. |

### What phase 0 actually built

`shared/scoring.ts` is a faithful port, structured to be read side by side with
`app/scoring.py`. Equivalence is not assumed anywhere; it is tested two ways.

- `shared/scoring.test.ts` ports `tests/test_scoring.py` test for test.
- `shared/scoring.golden.test.ts` runs the port over the real Fall 2026 night
  and requires identical standings, board order and all eleven prize winners.

`shared/fixtures/fall-2026.json` is that night: 8 players, 2 pods, 3 matches,
156 turn rows, with the players' names replaced by pseudonyms **in the original
roster order**, because roster order is the engine's last-resort tiebreaker and
reshuffling it would change who wins a surviving tie.

Python stays the reference implementation. `scripts/fixture_expected.py`
recomputes the fixture's `derived` and `expected` halves from its `raw` rows
using the real app, and `tests/test_fixture.py` runs that check in the pytest
suite. A change to either engine turns one of the two suites red; the engines
cannot drift apart with everything green.

### Field names stay snake_case

`shared/scoring.ts` keeps `combat_dmg_dealt`, `win_points` and the rest in
snake_case rather than converting to camelCase. Config refers to these fields
*by name as strings* (`metric: combat_dmg_dealt`, `tiebreak.field: win_points`),
so the property names are part of the config format. Renaming them would break
every existing `event.yaml`, and quietly: an unknown metric reads as zero for
everyone rather than raising, which is how a prize silently never awards.

## Consequences

**A real test gap closed.** Porting surfaced one. Mutating both engines so a
NULL `placement` scored as if the player had finished first passed all 413
Python tests. That is not an edge case: `placement` is NULL for every player
mid-match by design, which is what keeps the projected board live, so the
regression would have shown win points nobody had earned on the projector
during every match and corrected itself only as deaths were entered. Both
suites now cover it (`test_a_player_still_in_the_game_scores_no_win_points`).

**The config-never-ships trap disappears in phase 1.** Today `config/event.yaml`
lives only on the deployment host, excluded from deploys, and a renamed
scoring field
resolves every prize to unclaimed with no error and no log line. Event config
moving into the database and being edited in the admin UI, which multi-event
requires anyway, removes that failure mode rather than documenting it.

**The SSE broadcaster had to change shape, not just language.** `app/events.py`
was a module-level set of asyncio queues, which was sound because the unit
pinned `--workers 1`: one process, one set, every save and every subscriber in
it. Workers isolates do not share memory and are recycled, so the same code
would have held whichever subscribers happened to land in the same isolate, and
a save handled elsewhere would have pushed to none of them. The projector would
have stopped updating, silently, which looks exactly like a board where nothing
has happened. The set lives in one Durable Object instead, reached by name so
every isolate finds the same one.

Two things about that object are worth knowing before touching it. Its writes
are never awaited: a `TransformStream`'s readable side has a highWaterMark of 0,
so `write()` does not resolve until something reads the other end, and awaiting
the first write deadlocked every connection because the stream was the body of a
`Response` that had not been returned yet. The same await in the publish path
would have let one idle screen hold up the save that triggered it. And every
line of a frame carries its own `data:` prefix, because SSE is a line protocol
and the board is multi-line HTML: without it everything after the first newline
is dropped, which truncates the board to its opening `div` and reads as a
rendering bug.

The push also moved off the critical path. The Python broadcast was in-process
and free, and each subscriber's generator re-rendered from storage. Here the
Worker renders once for the room and hands the push to `waitUntil`, because a
tracker with a table waiting notices 200ms far more than the room notices the
board arriving a moment later.

**Two engines exist until phase 2 lands.** That is the cost of verifying before
rewriting, and it is bounded: the Python engine is deleted when the Worker
serves traffic. What must not happen is the two being maintained in parallel
indefinitely, which is also why the fixture gate is wired into CI rather than
left as a script someone remembers to run.

**The offline fallback is an open question, deferred to phase 4.** The podman
kit in `docs/EMERGENCY.md` needs nothing but a laptop and a local network.
`wrangler dev --local` runs the same workerd runtime as production and needs no
Cloudflare connection, so it is the single-codebase answer, but it is a
development server rather than a production one and has to be rehearsed before
anyone relies on it. Keeping the Python app alive purely as a fallback was
considered and rejected: two implementations of eleven prize rules drifting
apart is worse than the problem it solves.

**No event is scheduled.** That is what makes this the right moment. If one is
booked while a phase is in flight, the LXC deployment runs that night and the
cutover waits.
