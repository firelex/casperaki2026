#!/usr/bin/env bash
# docs/54o §Loop ablation runner. Used by run-loop-variant.sh once per variant.
#
# Usage: VARIANT=<n-name> bash apps/engine-spike/scripts/loop-ablation-runner.sh
#
# - Re-emits the loop spike (always — keeps inst-2.json + song.json fresh).
# - Rebuilds the native binary (caller should `touch` modified engine
#   files first so cmake picks them up).
# - Runs the render with a 60s timeout.
# - Records key metrics into /tmp/loop-ablation/$VARIANT.txt.

set -u
RESULTS=/tmp/loop-ablation
mkdir -p "$RESULTS"

VARIANT="${VARIANT:-unset}"
LOG="$RESULTS/$VARIANT.log"
OUT_WAV="apps/engine-spike/out/loop-only-spike/out.wav"

echo "=== $VARIANT ===" | tee -a "$RESULTS/SUMMARY.txt"

# Rebuild (incremental — cmake only recompiles touched files)
echo "--- build ---" | tee -a "$LOG"
cmake --build apps/engine-spike/native/build --target casperaki_spike -j 4 >> "$LOG" 2>&1
build_rc=$?
echo "build rc=$build_rc" | tee -a "$RESULTS/SUMMARY.txt"
if [ $build_rc -ne 0 ]; then
  echo "  BUILD FAILED — abort variant" | tee -a "$RESULTS/SUMMARY.txt"
  tail -10 "$LOG" | tee -a "$RESULTS/SUMMARY.txt"
  exit 1
fi

# Re-emit spike (cheap — only patches inst/song + stages files)
echo "--- emit-loop-spike ---" | tee -a "$LOG"
node apps/engine-spike/scripts/emit-loop-spike.mjs >> "$LOG" 2>&1

# Run render with 60s timeout
echo "--- render ---" | tee -a "$LOG"
rm -f "$OUT_WAV"
timeout 60 ./apps/engine-spike/native/build/casperaki_spike_artefacts/Debug/casperaki_spike \
  "$(pwd)/apps/engine-spike/out/loop-only-spike" http://127.0.0.1:8080 \
  "$(pwd)/$OUT_WAV" >> "$LOG" 2>&1
render_rc=$?

# Extract metrics
set_song_done=$(grep -c "SET SONG DONE" "$LOG" || true)
render_started=$(grep -c "renderToFile" "$LOG" || true)
cpus_line=$(grep -c "Number of CPUs available" "$LOG" || true)
ab1902=$(grep -c "tracktion_AudioClipBase.cpp:1902" "$LOG" || true)
crash_assertion=$(grep -c "juce_ReferenceCountedObject.h:394" "$LOG" || true)
wav_size=$(stat -c '%s' "$OUT_WAV" 2>/dev/null || echo "0")

echo "  render rc=$render_rc (124=timeout, 139=segfault)" | tee -a "$RESULTS/SUMMARY.txt"
echo "  SET SONG DONE lines: $set_song_done" | tee -a "$RESULTS/SUMMARY.txt"
echo "  renderToFile lines:  $render_started" | tee -a "$RESULTS/SUMMARY.txt"
echo "  Number of CPUs line: $cpus_line" | tee -a "$RESULTS/SUMMARY.txt"
echo "  AudioClipBase:1902:  $ab1902 assertions" | tee -a "$RESULTS/SUMMARY.txt"
echo "  RefCounted:394:      $crash_assertion assertions" | tee -a "$RESULTS/SUMMARY.txt"
echo "  WAV size: $wav_size bytes" | tee -a "$RESULTS/SUMMARY.txt"

if [ "$wav_size" != "0" ] && [ $render_rc -eq 0 ]; then
  stats=$(node apps/engine-spike/scripts/check-wav.mjs "$OUT_WAV" 2>&1 | tail -1)
  echo "  $stats" | tee -a "$RESULTS/SUMMARY.txt"
  if [ -f "$OUT_WAV" ]; then
    cp "$OUT_WAV" "$RESULTS/$VARIANT.wav"
  fi
fi
echo "" | tee -a "$RESULTS/SUMMARY.txt"
