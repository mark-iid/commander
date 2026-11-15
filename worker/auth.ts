// Shared-passcode session auth, ported from app/auth.py (ADR 0001, decision 6).
//
// No user accounts: one passcode, held as a Worker secret, exchanged for a
// signed cookie. That matches the trust model of a private game night while
// still being safe to expose on the internet, and Cloudflare Access is the
// recommended second layer.
//
// Three things changed in the move off FastAPI, each because the platform did:
//
//   * The throttle is a D1 table, not a dict. See migrations/0002.
//   * There is no startup check. FastAPI refused to boot on a missing
//     passcode; a Worker has no boot, so the guard answers 503 instead. Same
//     intent: an unauthenticated /entry must not be reachable by accident.
//   * The cookie is always Secure, and the `secure_cookies` config knob is
//     gone. The Worker answers on one HTTPS hostname, and browsers treat
//     localhost as secure, so there is no case left where Secure is wrong.
//     That also retires the "served over plain HTTP" warning on the login
//     page, which existed because reaching the container directly on the LAN
//     made a Secure cookie silently undeliverable.

import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";

export const COOKIE_NAME = "session";

// Values that mean "nobody configured this yet".
const PLACEHOLDERS = new Set(["", "change-me", "changeme"]);

// Brute-force throttle. Deliberately short: behind Cloudflare every request in
// the room can share one source address, so a long lockout would take the whole
// room offline. 60s makes guessing impractical without turning a fat-fingered
// tracker into an outage.
export const LOCKOUT_AFTER = 5;
export const LOCKOUT_SECONDS = 60;

// A failure streak that has gone quiet for this long stops counting. Without
// it `fails` only ever rises, so four typos spread across a game night leave a
// tracker one typo away from a lockout they did nothing to earn.
const ATTEMPT_TTL_MS = 900_000;

// Hard ceiling on how many callers are tracked at once, because client_key is
// attacker-controlled.
const MAX_TRACKED = 4096;

// Truncated before use as a key. Comfortably longer than an IPv6 address.
const KEY_MAX = 64;

export interface AuthSettings {
  passcode: string;
  secret: string;
  sessionHours: number;
  protectDisplay: boolean;
}

export function settings(env: Env): AuthSettings {
  // Not `Number(x) || 12`: that reads a deliberate 0 as "unset" and hands back
  // 12, so an operator who set SESSION_HOURS=0 would get twelve-hour sessions
  // and no indication their setting was discarded. Only a value that is not a
  // number, or is negative, falls back.
  const hours = Number(env.SESSION_HOURS);
  return {
    passcode: env.TRACKER_PASSCODE ?? "",
    secret: env.SESSION_SECRET ?? "",
    sessionHours: Number.isFinite(hours) && hours >= 0 ? hours : 12,
    protectDisplay: String(env.PROTECT_DISPLAY ?? "false") === "true",
  };
}

/** What is wrong with the configuration, or null if nothing is. */
export function misconfigured(env: Env): string | null {
  const s = settings(env);
  if (PLACEHOLDERS.has(s.passcode)) {
    return (
      "TRACKER_PASSCODE is unset or still the placeholder. Set it with" +
      " `wrangler secret put TRACKER_PASSCODE` before serving /entry or /admin."
    );
  }
  if (PLACEHOLDERS.has(s.secret)) {
    return (
      "SESSION_SECRET is unset or still the placeholder. Generate one with" +
      " `openssl rand -hex 32` and set it with `wrangler secret put SESSION_SECRET`."
    );
  }
  return null;
}

/**
 * Constant-time comparison.
 *
 * The passcode is short and shared, so a timing oracle is a realistic way to
 * shorten a guessing attack. Compares digests rather than bytes so the work is
 * independent of length as well as content.
 */
export async function checkPasscode(candidate: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(candidate)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0 && expected !== "";
}

// --- the session cookie -----------------------------------------------------

/**
 * Mark the caller signed in.
 *
 * The value carries when it was issued, and readSession rejects it once it is
 * older than SESSION_HOURS. Max-Age alone would be the browser's promise
 * rather than ours, and a cookie copied off a tracker's phone would then
 * outlive the night.
 */
export async function writeSession(c: Context<{ Bindings: Env }>): Promise<void> {
  const s = settings(c.env);
  await setSignedCookie(c, COOKIE_NAME, `authed:${Date.now()}`, s.secret, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: s.sessionHours * 3600,
  });
}

export function clearSession(c: Context<{ Bindings: Env }>): void {
  deleteCookie(c, COOKIE_NAME, { path: "/", secure: true });
}

export async function signedIn(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const s = settings(c.env);
  if (PLACEHOLDERS.has(s.secret)) return false;
  const raw = await getSignedCookie(c, s.secret, COOKIE_NAME);
  if (typeof raw !== "string") return false;
  const [marker, issued] = raw.split(":");
  if (marker !== "authed") return false;
  const at = Number(issued);
  if (!Number.isFinite(at)) return false;
  return Date.now() - at < s.sessionHours * 3600_000;
}

// --- throttling -------------------------------------------------------------

/**
 * Identify the caller for throttling.
 *
 * CF-Connecting-IP is set by Cloudflare and is attacker-controlled anywhere
 * else. That is acceptable for auth, because the header can only ever split
 * the throttle bucket and never bypass the passcode, but it is why the table
 * is bounded: a rotating value adds a row per request.
 */
export function clientKey(c: Context<{ Bindings: Env }>): string {
  const cf = c.req.header("CF-Connecting-IP");
  return (cf || "unknown").slice(0, KEY_MAX);
}

/** Seconds remaining on a lockout, or 0. */
export async function lockedFor(db: D1Database, key: string): Promise<number> {
  const row = await db
    .prepare("SELECT locked_until FROM login_attempts WHERE client_key = ?")
    .bind(key)
    .first<{ locked_until: number }>();
  if (!row) return 0;
  const remaining = row.locked_until - Date.now();
  return remaining > 0 ? Math.floor(remaining / 1000) + 1 : 0;
}

export async function recordFailure(db: D1Database, key: string): Promise<void> {
  const now = Date.now();
  // One statement so two simultaneous wrong guesses cannot both read 4 and
  // both write 5, leaving the counter short of the lockout.
  await db
    .prepare(
      `INSERT INTO login_attempts (client_key, fails, locked_until, last_seen)
       VALUES (?1, 1, 0, ?2)
       ON CONFLICT (client_key) DO UPDATE SET
         fails = CASE WHEN login_attempts.fails + 1 >= ?3 THEN 0
                      ELSE login_attempts.fails + 1 END,
         locked_until = CASE WHEN login_attempts.fails + 1 >= ?3 THEN ?2 + ?4
                             ELSE login_attempts.locked_until END,
         last_seen = ?2`,
    )
    .bind(key, now, LOCKOUT_AFTER, LOCKOUT_SECONDS * 1000)
    .run();
  await evict(db, now);
}

export async function recordSuccess(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM login_attempts WHERE client_key = ?").bind(key).run();
}

/**
 * Forget callers who are no longer being restrained.
 *
 * Two passes, because they answer different questions. The first drops entries
 * that have expired on their own merits: not locked, and quiet for
 * ATTEMPT_TTL. The second is the backstop for a caller cycling the header
 * faster than entries expire, trimming to MAX_TRACKED least-recently-seen
 * first. Active lockouts sort last and so survive the trim, which matters:
 * evicting a lockout would hand back the guesses it took to earn it.
 *
 * Only the failure path grows the table, so only the failure path prunes it.
 */
async function evict(db: D1Database, now: number): Promise<void> {
  await db
    .prepare("DELETE FROM login_attempts WHERE locked_until <= ?1 AND last_seen <= ?2")
    .bind(now, now - ATTEMPT_TTL_MS)
    .run();
  await db
    .prepare(
      `DELETE FROM login_attempts WHERE client_key IN (
         SELECT client_key FROM login_attempts
         ORDER BY locked_until, last_seen
         LIMIT MAX(0, (SELECT COUNT(*) FROM login_attempts) - ?1)
       )`,
    )
    .bind(MAX_TRACKED)
    .run();
}

// --- the guard --------------------------------------------------------------

/** Only same-site relative paths, so ?next= cannot be an open redirect. */
export function isSafeNext(target: string): boolean {
  return target.startsWith("/") && !target.startsWith("//");
}

export function protectedPrefixes(env: Env): string[] {
  // /results is always guarded, even when the board is public: the CSV carries
  // per-game rows for named people, which is a step past the standings the
  // room can already see on the projector.
  //
  // Both /results and /results.csv are listed because isProtected respects
  // segment boundaries, so a "/results" prefix deliberately does NOT cover
  // "/results.csv". Dropping the second entry leaves the whole night's data
  // downloadable without the passcode, and nothing about the page being
  // guarded would hint at it.
  const prefixes = ["/entry", "/admin", "/results", "/results.csv"];
  // The projected board is public unless configured otherwise, which was a
  // YAML edit and is now a Worker var.
  if (settings(env).protectDisplay) prefixes.push("/display");
  return prefixes;
}

/** Prefix match on a segment boundary, so /entrypoint is not part of /entry. */
export function isProtected(path: string, prefixes: string[]): boolean {
  return prefixes.some((p) => path === p || path.startsWith(p + "/"));
}
