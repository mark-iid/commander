-- Login throttle state.
--
-- app/auth.py kept this in a module-level dict, which was sound when the event
-- ran on one uvicorn worker with --workers 1. On Workers it would be per
-- isolate: requests spread across isolates that come and go, so five guesses
-- could each land somewhere with a clean slate, and a lockout would evaporate
-- whenever an isolate was recycled. A throttle that cannot be relied on is
-- worse than none, because it reads as protection.
--
-- So it is a table. Failures are rare, successes delete the row, and the
-- cleanup in worker/auth.ts bounds it by both age and count the same way
-- _evict() did.
--
-- Times are epoch milliseconds rather than a monotonic clock: there is no
-- shared monotonic clock across isolates, and Date.now() is the same scale
-- everywhere.
CREATE TABLE login_attempts (
  -- CF-Connecting-IP, truncated. Attacker-controlled, which is why the row
  -- count is capped: see worker/auth.ts.
  client_key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0 CHECK (fails >= 0),
  locked_until INTEGER NOT NULL DEFAULT 0 CHECK (locked_until >= 0),  -- 0 = not locked
  last_seen INTEGER NOT NULL
) STRICT;

-- The eviction pass orders by (locked_until, last_seen) so active lockouts sort
-- last and survive a trim. Evicting a lockout would hand back the guesses it
-- took to earn it.
CREATE INDEX idx_login_attempts_evict ON login_attempts(locked_until, last_seen);
