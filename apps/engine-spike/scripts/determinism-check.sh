#!/usr/bin/env bash
# Phase 0 (docs/60) determinism probe: render the SAME envelope twice with the
# SAME sample bytes and compare. Any difference is purely engine-side RNG
# (juce::Random velocity humanization is default-seeded from the wall clock;
# Sequencer::getDefaultSegmentBars uses libc rand() which is unseeded → stable).
# This is the empirical half of the "is the native render bit-reproducible?"
# question that gates the golden-master WAV oracle.
set -uo pipefail
cd "$(dirname "$0")/.."   # apps/engine-spike

GENDIR="out/all-genre-render-smoke/brightPop"
BIN="native/build/casperaki_spike_artefacts/Debug/casperaki_spike"
OUT1="$GENDIR/det-run1.wav"
OUT2="$GENDIR/det-run2.wav"
STUB_PORT=8080

echo "[det] starting sample stub server on :$STUB_PORT"
node scripts/sample-stub-server.mjs --port "$STUB_PORT" >/tmp/det-stub.log 2>&1 &
STUB_PID=$!
trap 'kill $STUB_PID 2>/dev/null' EXIT
sleep 1

echo "[det] prestaging samples for $GENDIR"
BRAIN_OUT_DIR="$GENDIR" node scripts/prestage-samples.mjs >/tmp/det-prestage.log 2>&1 \
  || { echo "[det] prestage failed (see /tmp/det-prestage.log) — continuing, stub fallback may cover it"; }

for run in 1 2; do
  OUT="$GENDIR/det-run$run.wav"
  rm -f "$OUT"
  echo "[det] render $run → $OUT"
  SPIKE_RENDER_TIMEOUT_SECS=300 "$BIN" "$GENDIR" "http://127.0.0.1:$STUB_PORT" "$OUT" \
    >"/tmp/det-render$run.log" 2>&1
  echo "[det] run$run rc=$? size=$(stat -c%s "$OUT" 2>/dev/null || echo MISSING)"
done

echo "[det] === RESULT ==="
ls -l "$OUT1" "$OUT2" 2>/dev/null
M1=$(md5sum "$OUT1" 2>/dev/null | awk '{print $1}')
M2=$(md5sum "$OUT2" 2>/dev/null | awk '{print $1}')
echo "[det] md5 run1=$M1"
echo "[det] md5 run2=$M2"
if [ -n "$M1" ] && [ "$M1" = "$M2" ]; then
  echo "[det] VERDICT: BIT-IDENTICAL (deterministic)"
else
  echo "[det] VERDICT: DIFFER (non-deterministic) — sample-exact null invalid; need tolerance"
  if command -v cmp >/dev/null; then
    cmp -l "$OUT1" "$OUT2" 2>/dev/null | head -1 | awk '{print "[det] first differing byte offset:", $1}'
    echo "[det] differing byte count: $(cmp -l "$OUT1" "$OUT2" 2>/dev/null | wc -l)"
  fi
fi
echo "[det] DONE"
