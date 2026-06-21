#!/usr/bin/env bash
# Robust determinism probe (docs/63 §7). Same intent as determinism-check.sh, but
# tolerant of the native binary's teardown hang: the spike binary writes the full
# WAV and then can stall for hours in Wine/yabridge + JUCE leak-detector shutdown,
# which makes the plain script wait forever before run 2. Here each render runs
# detached and is KILLED once its output WAV size has been stable for two polls
# (the WAV is fully flushed before the hang), then we md5-compare the two runs.
set -uo pipefail
cd "$(dirname "$0")/.."   # apps/engine-spike

GENDIR="out/all-genre-render-smoke/brightPop"
BIN="native/build/casperaki_spike_artefacts/Debug/casperaki_spike"
STUB_PORT=8080

echo "[det] stub server on :$STUB_PORT"
node scripts/sample-stub-server.mjs --port "$STUB_PORT" >/tmp/det-stub.log 2>&1 &
STUB_PID=$!
trap 'kill -9 $STUB_PID 2>/dev/null; pkill -9 -f casperaki_spike 2>/dev/null; pkill -9 -f yabridge 2>/dev/null' EXIT
sleep 1

echo "[det] prestage $GENDIR"
BRAIN_OUT_DIR="$GENDIR" node scripts/prestage-samples.mjs >/tmp/det-prestage.log 2>&1 \
  || echo "[det] prestage non-zero (stub fallback may cover) — continuing"

render_once () {
  local out="$1"; local log="$2"
  rm -f "$out"
  SPIKE_RENDER_TIMEOUT_SECS=300 "$BIN" "$GENDIR" "http://127.0.0.1:$STUB_PORT" "$out" >"$log" 2>&1 &
  local pid=$!
  local last=-1 cur=0 stable=0 waited=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 5; waited=$((waited+5))
    cur=$(stat -c%s "$out" 2>/dev/null || echo 0)
    if [ "$cur" -gt 0 ] && [ "$cur" = "$last" ]; then
      stable=$((stable+1))
      if [ "$stable" -ge 2 ]; then
        echo "[det] WAV stable at $cur bytes after ${waited}s — killing hung binary"
        kill -9 "$pid" 2>/dev/null; pkill -9 -f yabridge 2>/dev/null
        break
      fi
    else
      stable=0
    fi
    last="$cur"
    if [ "$waited" -ge 400 ]; then echo "[det] timeout ${waited}s"; kill -9 "$pid" 2>/dev/null; break; fi
  done
  wait "$pid" 2>/dev/null
  echo "[det] -> $out size=$(stat -c%s "$out" 2>/dev/null || echo MISSING)"
}

echo "[det] render 1"; render_once "$GENDIR/det-run1.wav" /tmp/det-render1.log
echo "[det] render 2"; render_once "$GENDIR/det-run2.wav" /tmp/det-render2.log

echo "[det] === RESULT ==="
M1=$(md5sum "$GENDIR/det-run1.wav" 2>/dev/null | awk '{print $1}')
M2=$(md5sum "$GENDIR/det-run2.wav" 2>/dev/null | awk '{print $1}')
echo "[det] md5 run1=$M1"
echo "[det] md5 run2=$M2"
if [ -n "$M1" ] && [ "$M1" = "$M2" ]; then
  echo "[det] VERDICT: BIT-IDENTICAL (deterministic) ✅"
else
  echo "[det] VERDICT: DIFFER (non-deterministic)"
  command -v cmp >/dev/null && cmp -l "$GENDIR/det-run1.wav" "$GENDIR/det-run2.wav" 2>/dev/null | head -1 \
    | awk '{print "[det] first differing byte offset:", $1}'
fi
echo "[det] DONE"
