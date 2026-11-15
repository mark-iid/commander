-- Commander Tracker schema. SQLite dialect, written to stay Postgres-portable.
-- Applied by app/db.py on startup. Keep all SQL behind app/repository.py.
--
-- Granularity note (supersedes the "one row per player per game" claim in
-- ADR 0001): the event owner's tracking sheet records a row per player per TURN
-- CYCLE, with per-opponent combat damage. See docs/DATA_MODEL.md.
--
-- Vocabulary, taken from that sheet so the schema and the trackers agree:
--   match_no  which of the night's games (1..games_per_player)
--   round_no  the turn cycle within one match
-- `games.round` used to mean match_no, which collided with the sheet's "Round #".

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
    event_id          INTEGER PRIMARY KEY,
    name              TEXT NOT NULL,
    date              TEXT,
    games_per_player  INTEGER NOT NULL DEFAULT 3,
    notes             TEXT
);

CREATE TABLE IF NOT EXISTS players (
    player_id   INTEGER PRIMARY KEY,
    event_id    INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    commander   TEXT,
    UNIQUE (event_id, name)
);

CREATE TABLE IF NOT EXISTS games (
    game_id     INTEGER PRIMARY KEY,
    event_id    INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    pod         TEXT,               -- 'A' | 'B'
    match_no    INTEGER,
    started_at  TEXT,
    ended_at    TEXT
);

-- Who sits at a table, and in what turn order.
--
-- Seating rotates between matches, so pod membership has to be recorded rather
-- than inferred. It used to be implicit -- "who is in pod A" meant "whoever has
-- a stat row" -- which was circular: the entry form could not offer the pod's
-- players until somebody had already saved one. It also has to exist before a
-- per-opponent damage grid can know which three opponents to show.
CREATE TABLE IF NOT EXISTS game_seats (
    game_id     INTEGER NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
    player_id   INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
    seat        INTEGER NOT NULL,   -- turn order at the table, 1..pod_size
    PRIMARY KEY (game_id, player_id),
    UNIQUE (game_id, seat)
);

-- One row per player per turn cycle: the sheet's columns A-D, N-P.
CREATE TABLE IF NOT EXISTS turn_stats (
    game_id              INTEGER NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
    player_id            INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
    round_no             INTEGER NOT NULL CHECK (round_no >= 1),
    attacking_creatures  INTEGER NOT NULL DEFAULT 0,
    cmdr_dmg_dealt       INTEGER NOT NULL DEFAULT 0,
    noncombat_dmg_dealt  INTEGER NOT NULL DEFAULT 0,
    opps_eliminated      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (game_id, player_id, round_no)
);

-- Combat damage dealt to one opponent in one turn: the sheet's columns E-L,
-- but only for opponents actually seated at the table.
--
-- Deliberately not a `combat_dmg_dealt` scalar: the per-opponent breakdown is
-- strictly more information, and the scalar every prize uses is recovered by
-- SUMming this table (see _DERIVED_STATS in app/repository.py).
CREATE TABLE IF NOT EXISTS turn_damage (
    game_id     INTEGER NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
    player_id   INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
    round_no    INTEGER NOT NULL CHECK (round_no >= 1),
    target_id   INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
    combat_dmg  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (game_id, player_id, round_no, target_id),
    -- You cannot deal combat damage to yourself, and a self-row would be
    -- double-counted by both the dealt and taken aggregates.
    CHECK (player_id <> target_id)
);

-- The sheet's "Entered at Player Death or Win" section: the three values that
-- are only knowable once a player is out of the game.
--
-- placement stays NULL until then. That is what lets a tracker save a turn
-- mid-game: scoring reads it with placement_points.get(placement, 0), so an
-- unfinished row scores zero win points and still contributes its damage.
CREATE TABLE IF NOT EXISTS game_player_stats (
    game_id          INTEGER NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
    player_id        INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
    placement        INTEGER CHECK (placement BETWEEN 1 AND 4),
    final_life       INTEGER,
    total_graveyard  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (game_id, player_id)
);

-- Which deck a player brought to one match.
--
-- Keyed on (event, player, match) rather than carried on game_seats, because a
-- match reshuffles both pods and seats. Moving a player from pod A to pod B is
-- a deleted seat row under one game_id and a fresh one under another, and
-- seat_players rewrites a table's rows wholesale on any reseat -- so a
-- commander column on game_seats would be the one per-match value a reseat did
-- not give back, unlike turn_stats. The deck is a fact about the person and the
-- match, so that is what it hangs off, and neither a reseat nor a pod swap
-- touches it.
--
-- commander is NOT NULL: a blank box deletes the row instead of storing an
-- empty string, so "no deck recorded" is one state and not two. players.commander
-- stays the roster default, offered as the pre-fill for every match.
--
-- Nothing in app/scoring.py reads this. Commander damage travels with the
-- person, not with the deck they brought (event owner's call, 2026-11-14): the
-- night's cmdr_dmg_dealt stays a per-player sum however many decks it came from.
CREATE TABLE IF NOT EXISTS match_commanders (
    event_id   INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    player_id  INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
    match_no   INTEGER NOT NULL CHECK (match_no >= 1),
    commander  TEXT NOT NULL,
    PRIMARY KEY (event_id, player_id, match_no)
);

CREATE INDEX IF NOT EXISTS idx_gps_player ON game_player_stats(player_id);
CREATE INDEX IF NOT EXISTS idx_games_event ON games(event_id);
-- One game per (event, pod, match). Two trackers entering the same pod at the
-- same time would otherwise race and create duplicate games, splitting a pod's
-- stats. NULL pod/match (admin-created ad-hoc games) are exempt, as SQLite and
-- Postgres both treat NULLs as distinct in a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_games_event_pod_match ON games(event_id, pod, match_no);
CREATE INDEX IF NOT EXISTS idx_players_event ON players(event_id);
-- A whole match's decks are read at once; the PK's leading columns do not serve it.
CREATE INDEX IF NOT EXISTS idx_match_cmdr_match ON match_commanders(event_id, match_no);
CREATE INDEX IF NOT EXISTS idx_seats_player ON game_seats(player_id);
CREATE INDEX IF NOT EXISTS idx_turn_stats_player ON turn_stats(game_id, player_id);
CREATE INDEX IF NOT EXISTS idx_turn_damage_target ON turn_damage(game_id, target_id);
