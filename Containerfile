# Emergency local build: the whole app in one image, runnable on a laptop with
# nothing installed but podman. See docs/EMERGENCY.md and scripts/emergency.sh.
#
# Not how production is deployed — that is an rsync into an LXC container with a
# venv and systemd (see .forgejo/workflows/ci.yml). This exists so a dead host,
# a dead tunnel or a dead network on game night is a five-minute detour instead
# of the end of the event.
#
# 3.13 on purpose: the same interpreter the deployment host runs, so a night
# rescued by this image behaves like the one it replaced.
FROM docker.io/library/python:3.13-slim

# Install the package itself, not an editable checkout: there is no git metadata
# and nothing to edit in an emergency. LICENSE is copied because pyproject
# declares it in license-files and the build fails without it.
WORKDIR /srv
COPY pyproject.toml LICENSE README.md ./
COPY app ./app
COPY scripts ./scripts
COPY config/event.example.yaml ./config/event.example.yaml
RUN pip install --no-cache-dir .

# Everything that must survive the container lives in /data, which the start
# script bind-mounts from the host: config/event.yaml, commander.db, backups/.
# The app reads both paths from the environment (app/config.py, app/db.py).
ENV EVENT_CONFIG=/data/config/event.yaml \
    DB_PATH=/data/commander.db \
    PYTHONUNBUFFERED=1
WORKDIR /data

# TRACKER_PASSCODE and SESSION_SECRET are deliberately absent: the app refuses
# to start without them (app/auth.py), and baking a passcode into an image is
# how one ends up shared. They arrive via --env-file at run time.

EXPOSE 8000

# /login is the cheapest page that proves the app is really serving: it renders
# a template, so it covers the config load and the static-asset hashing too.
# Written in python because this image has no curl and does not need one.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/login', timeout=4).status == 200 else 1)"]

# ONE worker, always. The SSE broadcaster is in-process pub/sub (app/events.py),
# so a second worker would silently drop live updates for every client attached
# to the other process.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
