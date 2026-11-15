# Security

## Reporting

Use GitHub's private vulnerability reporting on this repository: **Security**
tab, then **Report a vulnerability**.

This is a scoreboard maintained by one person. There is no SLA.

## Threat model

There are no user accounts. One shared passcode, typed by every tracker, is
exchanged for a signed session cookie. That fits a private game night where the
people entering data are in the room. It does not give you per-user identity or
an audit trail.

`/entry`, `/admin`, `/results` and `/results.csv` answer 503 naming the missing
secret while `TRACKER_PASSCODE` or `SESSION_SECRET` is unset or still
`change-me`, rather than serving unauthenticated.

`/display` is public by default, because it is meant to be on a screen in the
room. `PROTECT_DISPLAY=true` gates it. `/results` is always gated even when the
board is open, because the CSV carries per-game rows for named people.

Cloudflare Access in front of the app is the answer if you need real identity
rather than a shared secret.

## Known limits

- The login throttle keys on `CF-Connecting-IP`, which is attacker-controlled
  anywhere not behind Cloudflare. It can only split the throttle bucket, never
  bypass the passcode, and the table it writes to is bounded by both age and
  row count.
- Behind Cloudflare, a whole room can share one source address, so the lockout
  is five attempts for 60 seconds. A longer one would take the room offline
  over a typo.
- The session cookie is signed, not encrypted. It carries a marker and an
  issued-at, no secret, and the issued-at is checked server side so a copied
  cookie does not outlive `SESSION_HOURS`.
- Player and deck names are free text, rendered escaped, and not sanitised on
  input.

## Secrets

`TRACKER_PASSCODE` and `SESSION_SECRET` are Worker secrets
(`wrangler secret put`) and `.dev.vars` locally, which is gitignored. The
example file carries placeholders the app refuses to start on.
