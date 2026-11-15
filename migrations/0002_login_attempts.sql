-- Login throttle state.
--
-- A table rather than in-process state: Workers isolates do not share memory
-- and are recycled, so five guesses could each land somewhere with a clean
-- slate and a lockout would evaporate. Failures are rare, successes delete the
-- row, and the cleanup in worker/auth.ts bounds it by both age and count.
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
