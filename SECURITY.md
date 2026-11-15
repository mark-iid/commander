# Security

## Reporting something

Use GitHub's private vulnerability reporting on this repository: **Security** tab,
then **Report a vulnerability**. That keeps the report private until there is a
fix, and needs no email address from either of us.

This is a games-night scoreboard maintained by one person in their spare time.
There is no SLA. What you will get is an acknowledgement and an honest answer
about whether and when it will be fixed.

## What this app actually is

Worth being plain about the threat model, because it is unusual and it is a
deliberate choice rather than an oversight.

**There are no user accounts.** One shared passcode, typed by every tracker,
exchanged for a signed session cookie. That matches a private game night where
the people entering data are in the room and the organiser tells them the
passcode. It does not match anything where you need to know who did what.

**The app refuses to serve its guarded surfaces without a configured passcode.**
`/entry`, `/admin`, `/results` and `/results.csv` answer 503 naming the missing
secret rather than serving unauthenticated. An unauthenticated `/entry` on the
internet is the specific failure that guard exists to prevent.

**The projected board is public by default**, because it is meant to be on a
screen in the room. `PROTECT_DISPLAY=true` gates it too. `/results` is always
guarded, even when the board is open, because the CSV carries per-game rows for
named people, which is a step past the standings the room can already see.

**Cloudflare Access in front of it is recommended**, and is the answer if you
want real identity rather than a shared secret.

### Known limits, stated rather than hidden

- The login throttle keys on `CF-Connecting-IP`, which is attacker-controlled
  anywhere that is not behind Cloudflare. It can only ever split the throttle
  bucket, never bypass the passcode, and the table it writes to is bounded by
  both age and row count for that reason.
- Behind Cloudflare, every tracker in a room can share one source address, so the
  lockout is deliberately short (five attempts, 60 seconds). A long lockout would
  take the whole room offline over one typo.
- The session cookie is signed, not encrypted. It carries no secret, only a
  marker and when it was issued, and the issued-at is checked server side so a
  cookie copied off a phone does not outlive `SESSION_HOURS`.
- Player names and deck names are free text and are rendered escaped. They are
  not sanitised on the way in, on purpose: a name is whatever its owner says it
  is.

## Secrets

`TRACKER_PASSCODE` and `SESSION_SECRET` are secrets and never belong in the
repository or in an event's configuration. On the Worker they are
`wrangler secret put`; locally they are `.dev.vars`, which is gitignored. The
example files carry placeholders that the app refuses to start on.

Neither `config/event.yaml` nor `.env` has ever been committed to this
repository, and both are gitignored.
