#!/usr/bin/env bash
# docs/60 Phase 0 — produce a golden resolved-event dump for one genre.
# The harness writes the dump at the start of runRender (before the WAV
# render), so we poll for the JSON and stop the process once it lands.
set -uo pipefail
cd "$(dirname "$0")/.."

GENDIR="${1:-out/all-genre-render-smoke/brightPop}"
BIN="native/build/casperaki_spike_artefacts/Debug/casperaki_spike"
DUMP="$GENDIR/resolved-events.json"
rm -f "$DUMP"

pkill -f sample-stub-server 2>/dev/null || true
sleep 1
node scripts/sample-stub-server.mjs --port 8080 >/tmp/dump-stub.log 2>&1 &
STUB=$!
sleep 1

SPIKE_DUMP_EVENTS="$(pwd)/$DUMP" "$BIN" "$GENDIR" "http://127.0.0.1:8080" "/tmp/dump-throwaway.wav" \
  >/tmp/dump-run.log 2>&1 &
PID=$!

for i in $(seq 1 90); do
  if [ -f "$DUMP" ]; then echo "[dump] appeared after ~${i}s"; sleep 1; break; fi
  if ! kill -0 "$PID" 2>/dev/null; then echo "[dump] process exited before dump"; break; fi
  sleep 1
done

kill "$PID" 2>/dev/null || true
kill "$STUB" 2>/dev/null || true
wait 2>/dev/null

echo "[dump] === harness log ==="
grep -E "genre=|setSong|resolved-event dump|FATAL|dump failed" /tmp/dump-run.log | tail -10
echo "[dump] === result ==="
ls -l "$DUMP" 2>/dev/null && echo "[dump] OK" || echo "[dump] MISSING"
