# Data Model
One row per player per turn cycle, plus a short per-game section filled in when a
player is out. This follows the event owner's tracking sheet, which is turn-shaped
with a damage column per opponent.

A per-game design was tried first and abandoned: it required a placement on every
save, so nothing could be recorded until a game had finished.

Two words that used to be one:

| Term | Means | Column |
|---|---|---|
| **Match** | one of the night's games (1..`games_per_player`) | `games.match_no` |
| **Round** | one turn cycle *inside* a match | `turn_stats.round_no` |

`games.round` used to mean the match number. It was renamed because the tracking sheet
uses "Round #" for the turn cycle, and one word meaning two things is a bug waiting to
be written.

## Tables

**events** — one tournament night
```
event_id (PK), name, date, games_per_player, notes
```

**players** — one person per event
```
player_id (PK), event_id (FK), name, commander (nullable)
```
`commander` here is the player's *usual* deck, used as the pre-fill on the entry form.
What they actually brought to a given match lives in `match_commanders` below.

**games** — one match played by one pod
```
game_id (PK), event_id (FK), pod, match_no, started_at, ended_at
```

**game_seats** — who is at a table, in turn order
```
game_id (FK), player_id (FK), seat   -- 1..pod_size
PRIMARY KEY (game_id, player_id)
```
Seating rotates every match, so it is recorded rather than inferred. It used to be
implicit — "who is in pod A" meant "whoever has a stat row" — which was circular: the
entry form could not offer the pod's players until somebody had already saved one. It
is also what lets the damage grid show three opponents instead of the whole roster.

**match_commanders** — which deck a player brought to one match
```
event_id (FK), player_id (FK), match_no, commander   -- NOT NULL
PRIMARY KEY (event_id, player_id, match_no)
```
Players may change commander between matches, so the deck is recorded per match rather
than once on the roster.

Keyed on **(event, player, match)**, not carried on `game_seats`, because every match
deals the pods and the seats again. Moving a player from pod A to pod B is a deleted
seat row under one `game_id` and a fresh one under another, and `seat_players` rewrites
a table's rows wholesale on any reseat — so a `commander` column there would be the one
per-match value a reseat did not give back, unlike `turn_stats`. The deck is a fact
about the person and the match, so that is what it hangs off: neither a reseat nor a
pod swap touches it.

A blank box deletes the row rather than storing `''`, which keeps "no deck recorded" a
single state. `clear_results` wipes the table for the same reason it wipes seating: a
deck pre-filled for a match with no results is a stale arrangement, not a result.

**Nothing in the scoring engine reads this.** Commander damage travels with the person,
not with the deck they brought (event owner's call, 2026-11-14) — see "What counts as
damage" below.

**turn_stats** — one row per player per turn cycle
```
game_id (FK), player_id (FK), round_no,
attacking_creatures       -- declared this combat
cmdr_dmg_dealt            -- subset of combat; tracked separately for the 21-dmg prizes
noncombat_dmg_dealt
opps_eliminated
PRIMARY KEY (game_id, player_id, round_no)
```

**turn_damage** — combat damage to one opponent in one turn
```
game_id (FK), player_id (FK), round_no, target_id (FK), combat_dmg
PRIMARY KEY (game_id, player_id, round_no, target_id)
CHECK (player_id <> target_id)
```
A zero is stored as an absent row, so nobody has to type a zero to say "I did not
attack them".

**game_player_stats** — the sheet's "Entered at Player Death or Win" section
```
game_id (FK), player_id (FK),
placement                 -- 1..4 finish; NULL while the player is still alive
final_life                -- life at death / game end; placement tiebreak context
total_graveyard           -- cards in the yard, counted once at the end
PRIMARY KEY (game_id, player_id)
```

`placement` being nullable is what lets a turn be saved mid-match. `build_standings`
reads it through `placement_points.get(placement, 0)`, so an unfinished game scores
zero win points while its damage still counts toward the damage prizes — which is what
keeps the projected leaderboard live during play.

Win Points is **derived** (placement → points via config, summed per player), never stored.

## Derived per-game stats

The scoring engine consumes one `GamePlayerStat` per player per game, assembled from the
turn tables by the query in `shared/aggregate.ts`, which is the
whole of the translation between the two granularities — and the reason the scoring engine
did not change when the granularity did.

| Derived field | From |
|---|---|
| `combat_dmg_dealt` | SUM of `turn_damage.combat_dmg` |
| `noncombat_dmg_dealt`, `cmdr_dmg_dealt`, `opps_eliminated` | SUM over `turn_stats` |
| `biggest_attack_dealt` | MAX over turns of that turn's combat damage, summed across opponents |
| `biggest_attack_taken` | MAX of a single `turn_damage` row targeting the player |
| `most_creatures_in_attack` | MAX of `turn_stats.attacking_creatures` |
| `placement`, `final_life`, `total_graveyard` | joined from `game_player_stats` |

"Biggest attack dealt" sums across opponents because one declared attack in Commander can
hit several players at once. "Biggest attack taken" does not, because each `turn_damage`
row is already exactly one dealer hitting one target in one turn.

The query is driven from `game_seats`, so a seated player who has not acted yet appears
with zeros and a NULL placement rather than vanishing from the standings.

## What counts as damage

The Technical Winner / Blame It On Shuffling tiebreaker is **combat damage dealt to players**
(`total_damage_fields` in config). Two trackers must count the same way or the tiebreaker is
noise, so:

**`combat_dmg_dealt` — counts:**
- Damage from attacking creatures that connects with a **player**, including trample spillover.
- Damage from blocking creatures is combat damage, but it hits creatures, not players — so it
  does not count here.
- Commander damage. It *is* combat damage: the rules eliminate a player at "21 points of
  combat damage by a particular Commander". Count it here **and** in `cmdr_dmg_dealt`; the
  scoring engine knows the second is a subset and never adds it twice.
  - **`cmdr_dmg_dealt` travels with the person, not the deck** (event owner's call,
    2026-11-14). A player who brings a different commander to each match has one
    `cmdr_dmg_dealt` total for the night, summed across all of them — which is what
    "21 Is Less Than 40" and "40 Is More Than 21" (`scope: night`) read.
    `match_commanders` records which deck was played; no prize keys off it.
  - With swapping allowed, "40 Is More Than 21" is in principle winnable by
    deliberately bringing a deck that cannot deal commander damage. That is fine
    here because **the players are not told the prize list exists** — the awards
    are a reveal at the end of the night, so there is nothing to play toward.
    Worth revisiting only if a future event publishes the prizes in advance.
- First-strike and double-strike damage, counted in both damage steps.

**`combat_dmg_dealt` — does NOT count:**
- Damage to creatures or planeswalkers. Player damage only.
- Damage from a triggered ability that fires during combat ("whenever this attacks, each
  opponent loses 2 life"). Combat is *when* it happened, not *what* it was — that is non-combat.

**`noncombat_dmg_dealt` — counts** burn spells, pingers, and any other damage to a player
outside the combat damage step. Recorded for the "Scared of the Sword" prize; **not** part of
the tiebreaker.

One genuine trap: **life loss is not damage.** Many drain effects say a player "loses life"
rather than "is dealt damage", so strictly they are neither combat nor non-combat damage.

**Event owner's rule: count them anyway — record life loss in `noncombat_dmg_dealt`.** This is
a deliberate departure from the strict rules text. "Scared of the Sword" exists to reward
hurting people without swinging, and a deck that drains forty life out of the table would
otherwise score zero on the one prize meant for it. This is a rule, not a per-tracker choice:
if two trackers decide it independently the prize becomes unauditable after the fact.

Format rules referenced: <https://mtgcommander.net/index.php/rules/> (40 starting life,
21 commander damage, commander damage is combat damage).

## Totals vs peaks

Both are now **computed**, not typed. A tracker enters what happened on a turn; the totals
are sums over those turns and the peaks are maxima.

This is the main practical win of the turn-level model. The peaks used to be running maxima
a tracker had to notice and overwrite by hand ("bump these during the round"), which is both
the easiest thing to forget in a live game and unauditable afterwards. The tracking sheet has
no biggest-attack column at all, for exactly this reason.

`total_graveyard` is the one value entered directly, once, at death or win. It replaced
`peak_graveyard`: the sheet asks for "Total Cards In Graveyard", which is a count of the pile
at the end, not a maximum during play. A deck that exiles or recurs its own yard will read
lower than its peak did — a deliberate change of basis for the Mill prize, on the event
owner's call.

## Getting the turns back out

Two views read the turn tables directly rather than the derived per-game stats:

- `GET /results/turns.csv` — one row per player per turn, a damage column per rostered
  player. Shaped after the event owner's tracking sheet, so the export is readable in a
  spreadsheet without a pivot.
- The **damage matrix** on `/results` — per game, a dealer x target grid with both margins.
  Row totals are damage dealt, column totals damage taken.

Everything else in the app reads the derived `GamePlayerStat` instead. These two are the only
places the per-opponent, per-turn detail is visible, and without them it would be recorded
and never seen again.

## Prize → source mapping

| Prize | metric | agg | scope | tiebreak (night totals) |
|---|---|---|---|---|
| Technical Winner | win_points | max | night | most combat damage dealt |
| Blame It On Shuffling | win_points | min | night | least combat damage dealt |
| Does Nobody Block? | combat_dmg_dealt | max | night (sum) | most creatures attacked with (`creatures_attacked_with`) |
| No Apologies | biggest_attack_dealt | max | peak | most combat damage dealt |
| You Should See the Other Guy | biggest_attack_taken | max | peak | most combat damage taken (`combat_dmg_taken`) |
| Yeah, But How Many Were 1/1s? | most_creatures_in_attack | max | peak | most combat damage dealt |
| Can't Spell Million Without Mill | total_graveyard | max | peak | most win points |
| 21 Is Less Than 40 | cmdr_dmg_dealt | max | night (sum) | most combat damage dealt |
| 40 Is More Than 21 | cmdr_dmg_dealt | min | night (sum) | most combat damage dealt |
| Assassin or Asshole? | opps_eliminated | max | night (sum) | most combat damage dealt |
| Scared of the Sword | noncombat_dmg_dealt | max | night (sum) | least combat damage dealt |

The tiebreaks are the event owner's, from the 2026 event notes. A tie that survives the
tiebreak goes to roster order. `creatures_attacked_with` and `combat_dmg_taken` exist only
for these tiebreaks: they are SUMs over the turn tables, derived like every other field.

A player named in `scoring.prize_ineligible` plays and scores as normal and keeps their place
in the standings, but is not a contender for any prize: each one they would have won goes to
the next in line. It exists for the organiser who also sits at a table. Names match the
roster exactly, so /admin refuses to rename that player until the new name is in the list
too. A single name written without brackets (`prize_ineligible: Jesse`) is read as that name.

All eleven compute from the derived `GamePlayerStat` + the placement→points rule, so
every prize kept working across the granularity change without a scoring edit.

### When a prize has no winner

A prize resolves to **unclaimed** (rendered as `—` on the sheet and greyed on the board)
in two cases, and the second is asymmetric between the aggregations:

- Nobody has played a game yet, so there are no contenders at all. Being seated is not
  playing: a player contends from their first saved turn, the first hit they take, or
  their death/win entry, whichever comes first.
- The prize is `agg: max` and the winning value is zero. "Most X" means somebody did X;
  if the whole field is on zero the prize goes to nobody, rather than to whoever happens
  to sort first — which, one round in, is just the first name on the roster.

`agg: min` prizes are deliberately exempt: zero is the *best* score for them. "40 Is More
Than 21" is meant to go to the player who dealt no commander damage at all.

## Placement rules (confirmed)

- Base: order of elimination. Last standing = 1st, last eliminated = 2nd, first out = 4th.
- Simultaneous deaths (one spell/combat): rank by life-at-death, least negative = higher.
- Game called on time: rank survivors by current life.
- Ties: tied players take the **better** of the placements they occupy and each receive
  its full score; the lower placement goes unused. Two players tied over 3rd and 4th both
  finish 3rd, and nobody finishes 4th.

The app does not re-derive placement from raw combat events — it has per-turn damage now,
but not eliminations in enough detail to reconstruct a finishing order, and the humans at
the table always know it. The tracker resolves the ordering live; there are two ways to
enter the result.

**The death/win section**, one player at a time, takes the `placement` outright, with
`final_life` for context. It is the correction path, and the only way to record a game
called on time.

**The "who went out" form** appears when a turn credits eliminations (`opps_eliminated`):
one row per death, in the order they happened, and the placement is *derived* rather than
asked for — first out of a table of four finishes 4th, so the numbers run down from however
many were still playing. Ticking *all killed at the same moment* applies the simultaneous
rule above instead: the rows are ranked by `final_life`, least negative higher, and equal
totals tie and take the better of the placements they occupy per the tie rule above. When
those deaths would leave one player standing, the same form asks for the winner's row as
well, since the winner's own three numbers are the ones nobody is left at the table to
supply.

It refuses a submission that lists *every* player still standing. The derived placements
would run down to the best one and hand it to somebody who is dead, which is the app
inventing a winner for a game that had none — and this event has no draw. A game that
ended without a winner goes in on each player's own form, one decision at a time.

That form is derived on every render — eliminations credited on the turns, minus the
players already recorded out — rather than only raised by the save that caused it. So a
reload keeps it, the other tracker sees it, and recording the deaths is what removes it. A
death nobody was credited for (a suicide, a concede, a deck-out) never raises it and is
entered on the player's own form.

Counts cannot tell such a death from a kill nobody ticked, though, so one can cancel the
other: credit one elimination, record one suicide, and the difference is zero with a death
still outstanding. The save that credits a kill therefore raises the rows itself as well,
which guarantees them at the moment it matters. A reload in that particular state does lose
the prompt — the player's own form remains the fallback it always was.

## Storage note

Model is deliberately relational and boring so SQLite → Postgres is a driver swap. Keep all
SQL in `worker/data.ts`, `worker/entry-data.ts` and `worker/admin-data.ts`.
