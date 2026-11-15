-- Commander Tracker, initial schema. Phase 1 of docs/adr/0003.
--
-- D1 is SQLite, so ADR 0002's model crosses over in shape: one row per player
-- per turn cycle (turn_stats + turn_damage), per-opponent combat damage, and a
-- small per-game section filled in at death or win. docs/DATA_MODEL.md still
-- describes it.
--
-- Conventions, following the other D1 project on this account: STRICT tables,
-- integer 0/1 for booleans, ISO 8601 UTC timestamps, YYYY-MM-DD dates, CHECK
-- with an IN list wherever a column is really an enum.
--
-- Deliberate deviation: primary keys stay event_id / player_id / game_id rather
-- than a bare `id`. Half the tables here have composite keys that read as
-- (game_id, player_id, round_no), the aggregation query joins on those names,
-- and app/schema.sql used them, so the import maps column for column with
-- nothing to transcribe. Fidelity is worth more here than house style.
--
-- WHAT CHANGED from app/schema.sql, all of it to make the app multi-event:
--
--  * Event configuration lives here rather than in config/event.yaml. Each
--    event carries its own prizes, placement points and damage fields, which
--    is the whole point: a second tournament is a row, not a redeploy. It also
--    removes the worst trap in the old deployment, where event.yaml lived only
--    on the host, was excluded from deploys, and a renamed scoring field left
--    every prize silently unclaimed.
--  * players.prize_eligible replaces scoring.prize_ineligible. A flag on the
--    person cannot be broken by a rename or by YAML reading a lone name as a
--    string of letters, both of which have happened.
--  * players.roster_position is explicit. Roster order is the scoring engine's
--    last-resort tiebreaker, so it must survive an admin editing the roster
--    rather than being whatever order the rows were inserted in.
--  * game_player_stats.placement is CHECK (>= 1), not BETWEEN 1 AND 4. pod_size
--    was already configurable and the old constraint contradicted it: a
--    five-player pod failed on write.
--  * pods are rows, not a YAML list, so a pod can be called "Table 1".

CREATE TABLE events (
  event_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  date TEXT,                                     -- YYYY-MM-DD, null if unscheduled
  games_per_player INTEGER NOT NULL DEFAULT 3 CHECK (games_per_player >= 1),
  -- How many seats at one pod. Drives the "N of M entered" badge and how many
  -- seats the seating form offers. Placement points below need one tier per
  -- seat for a full table to score.
  pod_size INTEGER NOT NULL DEFAULT 4 CHECK (pod_size >= 2),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- Set when a night is over. Archived events stay readable and keep their
  -- results; they are just not offered for entry.
  archived_at TEXT
) STRICT;

-- Which event the unqualified surfaces mean: /display on the projector, /entry
-- on a tracker's phone. One row, pinned by the CHECK. If it is empty the app
-- falls back to the newest event that is not archived, so a fresh database and
-- a deleted event both still resolve.
CREATE TABLE active_event (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE
) STRICT;

-- Concurrent tables. Entry creates exactly one game per (pod, match).
CREATE TABLE pods (
  event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (event_id, label)
) STRICT;
CREATE UNIQUE INDEX idx_pods_position ON pods(event_id, position);

CREATE TABLE players (
  player_id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- The roster default, offered as the pre-fill for every match. What a player
  -- actually brought to a match is match_commanders.
  commander TEXT,
  -- 0 for the organiser who plays and scores but takes no prize: each prize
  -- they would have won goes to the runner-up. They stay in the standings.
  prize_eligible INTEGER NOT NULL DEFAULT 1 CHECK (prize_eligible IN (0, 1)),
  -- Roster order, and so the last-resort tiebreaker between players level on
  -- a prize's metric and its tiebreak both.
  roster_position INTEGER NOT NULL,
  UNIQUE (event_id, name)
) STRICT;
CREATE UNIQUE INDEX idx_players_roster ON players(event_id, roster_position);
CREATE INDEX idx_players_event ON players(event_id);

-- placement (1 = first) -> win points. One row per finishing position.
CREATE TABLE placement_points (
  event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  placement INTEGER NOT NULL CHECK (placement >= 1),
  points INTEGER NOT NULL,
  PRIMARY KEY (event_id, placement)
) STRICT;

-- Which stat fields sum into the damage tiebreaker. Combat damage dealt to
-- players only (event owner, 2026-08-06). Commander damage is deliberately
-- absent because it IS combat damage and is already inside combat_dmg_dealt;
-- listing it would count those points twice. See docs/DATA_MODEL.md.
CREATE TABLE total_damage_fields (
  event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (event_id, field)
) STRICT;

-- One row per prize. metric is a stat field name or the literal 'win_points';
-- scope 'night' sums a player's games, 'peak' takes their single best.
--
-- The field names are not validated here and cannot be: the engine is generic,
-- and an unknown metric reads as zero for everyone rather than raising, which
-- is how a typo turns into a prize that never awards. shared/scoring.ts exports
-- KNOWN_FIELDS and a test holds the configured prizes to it.
CREATE TABLE prizes (
  event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  metric TEXT NOT NULL,
  agg TEXT NOT NULL CHECK (agg IN ('max', 'min')),
  scope TEXT NOT NULL CHECK (scope IN ('night', 'peak')),
  tiebreak_field TEXT,
  tiebreak_direction TEXT CHECK (tiebreak_direction IN ('max', 'min')),
  tiebreak_scope TEXT NOT NULL DEFAULT 'night' CHECK (tiebreak_scope IN ('night', 'peak')),
  position INTEGER NOT NULL,
  PRIMARY KEY (event_id, key),
  -- A tiebreak is a field and a direction together or neither. Half of one
  -- would silently fall back to roster order.
  CHECK ((tiebreak_field IS NULL) = (tiebreak_direction IS NULL))
) STRICT;
CREATE UNIQUE INDEX idx_prizes_position ON prizes(event_id, position);

CREATE TABLE games (
  game_id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  pod TEXT,
  match_no INTEGER CHECK (match_no IS NULL OR match_no >= 1),
  started_at TEXT,
  ended_at TEXT,
  FOREIGN KEY (event_id, pod) REFERENCES pods(event_id, label)
) STRICT;
CREATE INDEX idx_games_event ON games(event_id);
-- One game per (event, pod, match). Two trackers entering the same pod at the
-- same time would otherwise race and create duplicate games, splitting a pod's
-- stats. NULL pod/match (admin-created ad-hoc games) are exempt, as SQLite
-- treats NULLs as distinct in a unique index.
CREATE UNIQUE INDEX idx_games_event_pod_match ON games(event_id, pod, match_no);

-- Who sits at a table, and in what turn order. Seating rotates between
-- matches, so pod membership is recorded rather than inferred: the entry form
-- cannot offer a pod's players until somebody has saved one otherwise, and a
-- per-opponent damage grid has to know which opponents to show.
CREATE TABLE game_seats (
  game_id INTEGER NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  seat INTEGER NOT NULL CHECK (seat >= 1),
  PRIMARY KEY (game_id, player_id),
  UNIQUE (game_id, seat)
) STRICT;
CREATE INDEX idx_seats_player ON game_seats(player_id);

-- One row per player per turn cycle.
CREATE TABLE turn_stats (
  game_id INTEGER NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  round_no INTEGER NOT NULL CHECK (round_no >= 1),
  attacking_creatures INTEGER NOT NULL DEFAULT 0 CHECK (attacking_creatures >= 0),
  cmdr_dmg_dealt INTEGER NOT NULL DEFAULT 0 CHECK (cmdr_dmg_dealt >= 0),
  noncombat_dmg_dealt INTEGER NOT NULL DEFAULT 0 CHECK (noncombat_dmg_dealt >= 0),
  opps_eliminated INTEGER NOT NULL DEFAULT 0 CHECK (opps_eliminated >= 0),
  PRIMARY KEY (game_id, player_id, round_no)
) STRICT;
CREATE INDEX idx_turn_stats_player ON turn_stats(game_id, player_id);

-- Combat damage dealt to one opponent in one turn. Deliberately not a
-- combat_dmg_dealt scalar: the per-opponent breakdown is strictly more
-- information, and the scalar every prize uses is recovered by summing it.
CREATE TABLE turn_damage (
  game_id INTEGER NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  round_no INTEGER NOT NULL CHECK (round_no >= 1),
  target_id INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  combat_dmg INTEGER NOT NULL DEFAULT 0 CHECK (combat_dmg >= 0),
  PRIMARY KEY (game_id, player_id, round_no, target_id),
  -- You cannot deal combat damage to yourself, and a self-row would be double
  -- counted by both the dealt and taken aggregates.
  CHECK (player_id <> target_id)
) STRICT;
CREATE INDEX idx_turn_damage_target ON turn_damage(game_id, target_id);

-- The three values only knowable once a player is out of the game.
--
-- placement stays NULL until then, and that is load-bearing: it is what lets a
-- tracker save a turn mid-game, and the scoring engine reads it through
-- placement_points so an unfinished row scores zero win points while its
-- damage still counts toward the damage prizes. final_life has no lower bound
-- because it is routinely very negative.
CREATE TABLE game_player_stats (
  game_id INTEGER NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  placement INTEGER CHECK (placement IS NULL OR placement >= 1),
  final_life INTEGER,
  total_graveyard INTEGER NOT NULL DEFAULT 0 CHECK (total_graveyard >= 0),
  PRIMARY KEY (game_id, player_id)
) STRICT;
CREATE INDEX idx_gps_player ON game_player_stats(player_id);

-- Which deck a player brought to one match. Keyed on (event, player, match)
-- rather than carried on game_seats, because a match reshuffles both pods and
-- seats and a reseat rewrites a table's seat rows wholesale. The deck is a fact
-- about the person and the match, so that is what it hangs off.
--
-- Nothing in the scoring engine reads it: commander damage travels with the
-- person, not the deck they brought (event owner, 2026-11-14).
CREATE TABLE match_commanders (
  event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  match_no INTEGER NOT NULL CHECK (match_no >= 1),
  commander TEXT NOT NULL,
  PRIMARY KEY (event_id, player_id, match_no)
) STRICT;
-- A whole match's decks are read at once; the key's leading columns do not serve it.
CREATE INDEX idx_match_cmdr_match ON match_commanders(event_id, match_no);
