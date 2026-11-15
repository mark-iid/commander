# Emergency local run

The deployment this app was built for has four things that can fail on a Friday night and
cannot be fixed from a games table: the LXC host, the Cloudflare Tunnel, the house internet,
and DNS. This is the fallback for all four — the tracker in a container on the laptop that is
already in the room, serving the phones that are already on the wifi.

It is deliberately *not* how production runs (that is an rsync into an LXC container with a venv and
systemd — see `.forgejo/workflows/ci.yml`). Nothing here touches the real host, and the real
host does not need to be alive for any of it.

Everything is one script:

```bash
./scripts/emergency.sh prepare   # before the night, on a connected machine
./scripts/emergency.sh start     # on the night
```

## Do this before the night

```bash
./scripts/emergency.sh prepare
```

`prepare` needs internet, five minutes and `podman` (`sudo dnf install podman`). It:

1. builds the image from `Containerfile` — Python 3.13, the same interpreter the deployment
   host runs, plus every dependency;
2. **saves the image to a tarball** in the kit directory;
3. creates the kit directory itself: `~/commander-tracker-emergency`, holding
   `config/event.yaml`, a generated passcode and session secret in `.env`, and `backups/`.

Step 2 is the point of the whole design. `start` loads the image from that tarball, so on the
night it needs no registry, no `pip` and **no network at all** — not even to the internet, not
even to the house router. An emergency plan that only works while the internet does is not an
emergency plan.

Then rehearse it once: `start`, seat a table at `/entry`, record a turn, watch `/display`
update, `stop`. A plan nobody has run is a plan nobody has.

Two things worth doing while you are there:

- **Put the real event config in the kit.** `prepare` copies your `config/event.yaml` if you
  have one locally, and falls back to the example (roster Alice/Bob/Carol/Dave) if you do not.
  The example will not run your night. Paste the real roster, prizes and `prize_ineligible`
  into `~/commander-tracker-emergency/config/event.yaml`.
- **Paste that config in before you rehearse, or throw the rehearsal database away after.**
  `roster:` is read exactly once, when the database is first created, and `/admin` owns the
  roster from then on (see "Configuring an event" in the README). So a rehearsal run against
  the example config leaves Alice/Bob/Carol/Dave baked in, and editing the YAML afterwards
  changes nothing. The fix is to delete `~/commander-tracker-emergency/commander.db` after the
  rehearsal — there is nothing in it worth keeping — and let the next `start` seed the roster
  from the config you actually want.
- **Write the passcode on a card** and put it in the deck box. It is printed by `start` and
  lives in `~/commander-tracker-emergency/.env`. Every tracker has to type it.

## On the night

```bash
./scripts/emergency.sh start
```

It prints, in this order: the four surface URLs for this laptop, the same URLs at each of this
machine's LAN addresses (that is what the trackers' phones use), the passcode, and where the
database and config live. Project `/display` from this laptop; hand out the LAN `/entry` URL.

If a phone cannot load the address but the laptop can, it is the firewall, every time:

```bash
sudo firewall-cmd --add-port=8000/tcp      # until this machine reboots
```

The script prints that line unless it can confirm the port is already open.

### The rest of the commands

| | |
|---|---|
| `status` | container state and health, HTTP codes for `/login` `/display` `/entry`, the database's size and last write, the passcode |
| `logs` | follows the app's output |
| `backup` | snapshot the database mid-event, through SQLite's backup API — consistent even while two trackers are saving. Lands in `~/commander-tracker-emergency/backups/` |
| `stop` | stops and removes the container. The database and config stay |
| `restart` | `stop` then `start` — needed only after editing `.env`; `event.yaml` is picked up live |
| `seed FILE` | start from a copy of a production database instead of empty |

Environment overrides, if the defaults clash with something: `COMMANDER_PORT` (default 8000),
`COMMANDER_KIT` (default `~/commander-tracker-emergency`), `COMMANDER_CONTAINER`,
`COMMANDER_IMAGE`.

### Mid-event edits

`config/event.yaml` in the kit directory is re-read on the next request, so a wrong roster
name or a missing prize is a save away from fixed — no restart, and a file that does not parse
keeps the last good one in service rather than 500-ing the projector (`app/config.py`).

The roster is a different matter: `roster:` seeds the database only when the event row is first
created, and `/admin` owns it after that. Fix a name at `/admin`, not in the YAML.

A reset works the same as in production: `/admin` → Danger zone, or from the shell

```bash
podman exec -it commander-tracker-emergency python /srv/scripts/reset.py --results --yes
```

## What this cannot do

Be honest about these before the night rather than discovering them during it.

- **No remote access.** There is no tunnel and no DNS: everyone has to be on the same wifi as
  this laptop. If the wifi itself is the thing that died, a phone hotspot with the laptop and
  the phones on it works, and nothing needs internet on the other end of it.
- **Results do not merge back.** This database is a separate night's record. There is no
  merge: whatever is recorded here is either carried over whole (below) or kept as the paper
  record from `/results`.
- **The laptop must stay awake.** A suspend takes the tracker away from the room mid-game.
  Plug it in and set it to never sleep on AC.
- **One worker, on purpose.** The SSE broadcaster is in-process (`app/events.py`); a second
  worker would silently drop live updates for everyone attached to the other process. The
  `Containerfile` hard-codes `--workers 1`. Leave it.

## Afterwards

The night's record is in `~/commander-tracker-emergency/commander.db`. Three ways to keep it,
most to least recoverable:

1. **Take `/results` while the app is still up** — *Save as PDF*, *Download CSV* and *Download
   turns CSV*. This is the one that survives everything, including a laptop that will not boot
   tomorrow. Do this before `stop`.
2. **Keep the database file.** `backup` first, then copy `commander.db` somewhere that is not
   this laptop.
3. **Adopt it as production**, if the host comes back empty-handed and the emergency night is
   the only record: stop the service, back up the host's database, copy this one into
   `/var/lib/commander-tracker/commander.db`, start it again. Only sane because the schema is
   the same image's — do not try it against a different version of the app.

Going the other way — starting the emergency instance *from* production, so the night continues
where it left off — is `seed`:

```bash
./scripts/emergency.sh stop
./scripts/emergency.sh seed ~/from-the-host/commander.db
./scripts/emergency.sh start
```

It names both files and what it will overwrite, keeps the displaced database as a
`.displaced.<timestamp>` copy, and does nothing without a typed `yes`.

## If podman itself is the problem

Last resort, no container, straight from this checkout. The env vars are exported by hand on
purpose: **nothing in `app/` reads a `.env` file** (the container works because podman's
`--env-file` does the reading), so a `.env` here has no effect and the app refuses to start.

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -e .                                  # needs internet
cp config/event.example.yaml config/event.yaml    # then edit it

export TRACKER_PASSCODE=pick-something
export SESSION_SECRET=$(python3 -c "import secrets;print(secrets.token_hex(32))")
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1
```

`--host 0.0.0.0` is what makes it reachable from the phones; the default binds localhost only.
