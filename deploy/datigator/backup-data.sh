#!/usr/bin/env bash
# Nightly backup of what the site keeps outside git (cron on datigator, 03:30):
#   - the brain's databases (songs, projects, Pro mixes, reviews, comments; sessions), as
#     consistent copies taken while the brain runs (SQLite's backup API)
#   - the auth service's database (users, organisations), pg_dump
#   - the hum recordings (hum-lab), mirrored
# into $CASPERAKI_BACKUP_DIR (default: the owner's Dropbox, so a copy leaves the machine).
# Database copies are kept for 14 days, one folder per day. Renders, playback files,
# exports, videos and the sample cache are not backed up: the app makes them again.
# Exits non-zero on any failure; the log is ~/casperaki-data/backup.log.
set -euo pipefail

DATA=${CASPERAKI_DATA_DIR:-$HOME/casperaki-data}
DEST=${CASPERAKI_BACKUP_DIR:-"/mnt/d/Scissero Dropbox/Mathias Strasser/casperaki-backups"}
BRAIN_ENV=$HOME/.config/casperaki/brain.env
AUTH_ENV=$HOME/.config/casperaki/auth/.env
KEEP_DAYS=14
CA=$(cd "$(dirname "$0")/../.." && pwd)

[ -d "$(dirname "$DEST")" ] || { echo "backup target's parent $(dirname "$DEST") does not exist" >&2; exit 1; }
day="$DEST/$(date +%F)"
mkdir -p "$day.tmp"

# SQLite: the brain's own better-sqlite3, so the copy is consistent while the brain writes.
set -a; . "$BRAIN_ENV"; set +a
for db in "$BRAIN_SONGS_DB_PATH" "$BRAIN_AUTH_DB_PATH"; do
  (cd "$CA/apps/brain" && node -e '
    const Database = require("better-sqlite3");
    const [src, dst] = process.argv.slice(1);
    const db = new Database(src, { readonly: true, fileMustExist: true });
    db.backup(dst).then(() => db.close()).catch((e) => { console.error(e); process.exit(1); });
  ' "$db" "$day.tmp/$(basename "$db")")
done

# Postgres (auth service).
uri=$(grep -E '^POSTGRES_URI=' "$AUTH_ENV" | cut -d= -f2-)
[ -n "$uri" ] || { echo "POSTGRES_URI is not set in $AUTH_ENV" >&2; exit 1; }
pg_dump --format=custom --file="$day.tmp/casperaki_auth.pgdump" "$uri"

rm -rf "$day"
mv "$day.tmp" "$day"

# Hum recordings: one mirror (recordings are only ever added).
mkdir -p "$DEST/hum-lab"
rsync -a "$DATA/hum-lab/" "$DEST/hum-lab/"

# Old daily copies.
find "$DEST" -mindepth 1 -maxdepth 1 -type d -regex '.*/[0-9]\{4\}-[0-9][0-9]-[0-9][0-9]' -mtime +"$KEEP_DAYS" -exec rm -rf {} +

echo "$(date -Is) backup ok: $day ($(du -sh "$day" | cut -f1))"
