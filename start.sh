#!/usr/bin/env bash
# Beebo launcher for Termux. Run from anywhere: bash start.sh
cd "$(dirname "$0")" || exit 1

command -v termux-wake-lock >/dev/null && termux-wake-lock

PGDATA="${PREFIX:-/usr}/var/lib/postgresql"

# Start PostgreSQL if it is not already running.
pg_isready -q || pg_ctl -D "$PGDATA" -l "$HOME/pg.log" start >/dev/null

# Wait up to 10 seconds for it to accept connections.
for _ in 1 2 3 4 5 6 7 8 9 10; do
    pg_isready -q && break
    sleep 1
done
pg_isready -q || { echo "PostgreSQL failed to start. See ~/pg.log"; exit 1; }

# Load DATABASE_URL and the other settings from .env.
[ -f .env ] || { echo ".env missing"; exit 1; }
set -a
. ./.env
set +a

# Refresh the GIF and sticker picker manifests from static/gifs/ and static/stickers/.
python3 tools/build_gif_manifest.py || echo "GIF manifest build failed; continuing."
python3 tools/build_sticker_manifest.py || echo "Sticker manifest build failed; continuing."

exec python3 -B app.py
