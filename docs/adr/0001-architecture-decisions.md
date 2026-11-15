# ADR 0001 — Architecture decisions for Commander Tracker

Status: Accepted
Date: 2026-08-06

## Context

A recurring MTG Commander tournament night needs live stat tracking and a novelty-prize
leaderboard. Two pods play concurrently; two people enter data; a leaderboard should update
in real time on a projected screen. The tool should be generic/config-driven and is intended
to be open-sourced and self-hosted, reachable over the internet.

## Decisions

### 1. Backend: FastAPI + HTMX
Server-rendered HTML with HTMX for partial updates; minimal client JS. Chosen over Streamlit
(which fights concurrent multi-user entry and true real-time) and over a full SPA+API (more
than this needs). Consequence: we own the frontend; standings/leaderboard are server-rendered
partials swapped via HTMX/SSE.

### 2. Storage: SQLite now, Postgres-ready
SQLite in WAL mode. Single file, zero-ops, ideal on a Pi; write volume for a game night is
trivial and WAL keeps reads non-blocking during writes. All DB access sits behind a `Storage`
protocol (`app/repository.py`) so a `PostgresStorage` can drop in if this ever becomes
always-on with heavy concurrency. Consequence: no raw SQL outside the repository layer.

### 3. Real-time: Server-Sent Events
One-way server→client push fits a broadcast leaderboard better than websockets, and beats
polling on "instant." On save, the server recomputes and pushes the leaderboard partial.
Consequence: an in-process pub/sub (`app/events.py`); fine for single-process deployment.
If it ever scales to multiple workers, move the broadcast to Redis pub/sub.

### 4. Concurrency and surfaces
Three surfaces: tracker **entry** (two pods, concurrent), **admin/config**, and read-only
public **display**. SQLite WAL handles the concurrent writes at this scale.

### 5. Deployment: internet-reachable via Cloudflare Tunnel
Runs on the homelab; `cloudflared` exposes it without opening ports. Consequence: no LAN-trust
assumption. Auth is required — see decision 6.

### 6. Auth: session passcode + Cloudflare Access
App-level session passcode guards `/entry` and `/admin`. Cloudflare Access (Zero Trust) is
recommended as a second layer in front of those routes. Public `/display` may be open or
gated per event. No user accounts in v1 — a shared passcode matches the trust model of a
private game night while still being safe to expose.

### 7. Config-driven domain
Roster, scoring, and prizes live in `config/event.yaml`. The scoring engine is generic
(`{metric, agg, scope, tiebreak}`), so new events and new prizes are config edits. Keeps
MTG-specific vocabulary out of the core and makes the project reusable.

### 8. Tiebreaker basis: combat damage dealt to players
Date: 2026-08-06. Supersedes the open item this ADR previously carried, which defined
`total_damage` as combat + non-combat.

The Technical Winner / Blame It On Shuffling tiebreaker is **combat damage dealt to players**
(`total_damage_fields: [combat_dmg_dealt]`). Two parts, decided on different grounds:

- **Non-combat damage is excluded** — the event owner's decision, not a rules question. Burn,
  pingers and drains are still recorded in `noncombat_dmg_dealt` for the "Scared of the Sword"
  prize; they simply do not decide ties.
- **Commander damage is excluded from the list because it is already counted.** This one is
  settled by the format rules, not preference: a player loses to "21 points of *combat* damage
  by a particular Commander" (<https://mtgcommander.net/index.php/rules/>). Commander damage is
  combat damage, so every point is already inside `combat_dmg_dealt`; listing `cmdr_dmg_dealt`
  as well would count it twice and reward commander decks for nothing but being commander decks.

Consequence: this changed a result in the verified sample — Technical Winner moved from Carol
(81 total damage) to Bob (73 combat damage), because Carol's 25 points of non-combat damage no
longer outweigh Bob's 17-point lead in combat. `tests/test_scoring.py` encodes the new outcome.
The scoring engine itself is unchanged and remains generic; this is a config decision.
