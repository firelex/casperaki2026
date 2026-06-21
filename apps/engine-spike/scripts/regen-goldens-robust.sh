#!/usr/bin/env bash
# Regenerate the 8 full-FX golden out.wav with the DETERMINISED native engine
# (docs/63 §7; the SequencerUtils RNG is now fixed-seeded). Standalone + robust to
# the native binary's teardown hang (Wine/yabridge + JUCE leak-detector stall):
# each render runs detached and is KILLED once its output WAV size is stable for
# two 5s polls (the WAV is fully flushed before the hang). This is the golden
# regeneration that is Phase-2 entry condition #1 — render-all-genres.mjs's plain
# spawnSync(BIN) would block forever on the first teardown stall.
#
#   GENRES=brightPop,edm bash scripts/regen-goldens-robust.sh   # subset
set -uo pipefail
cd "$(dirname "$0")/.."          # apps/engine-spike
REPO_ROOT="$(cd ../.. && pwd)"

OUT_ROOT="out/all-genre-render-smoke"
BIN="native/build/casperaki_spike_artefacts/Debug/casperaki_spike"

# docs/65 — point the render at the built Casperaki VST3s so it also emits a
# producer-openable edit-vst3.trkedit (built-in FX swapped to VST3 references).
# Set CASPERAKI_VST3_DIR="" to skip and bundle the built-in edit instead.
: "${CASPERAKI_VST3_DIR:=$REPO_ROOT/apps/casperaki-vst3/build}"
export CASPERAKI_VST3_DIR
STUB_PORT="${STUB_PORT:-8080}"
ALL=(ballad brightPop edm latin organicVibes rock schlager urban)
if [ -n "${GENRES:-}" ]; then IFS=',' read -ra GENRES_ARR <<< "$GENRES"; else GENRES_ARR=("${ALL[@]}"); fi

echo "[regen] stub server on :$STUB_PORT"
node scripts/sample-stub-server.mjs --port "$STUB_PORT" >/tmp/regen-stub.log 2>&1 &
STUB_PID=$!
trap 'kill -9 $STUB_PID 2>/dev/null; pkill -9 -f casperaki_spike 2>/dev/null; pkill -9 -f yabridge 2>/dev/null' EXIT
sleep 1

render_once () {  # $1=genreDir  $2=out  $3=log
  local gendir="$1" out="$2" log="$3"
  rm -f "$out"
  SPIKE_RENDER_TIMEOUT_SECS=300 "$BIN" "$gendir" "http://127.0.0.1:$STUB_PORT" "$out" >"$log" 2>&1 &
  local pid=$! last=-1 cur=0 stable=0 waited=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 5; waited=$((waited+5))
    cur=$(stat -c%s "$out" 2>/dev/null || echo 0)
    if [ "$cur" -gt 0 ] && [ "$cur" = "$last" ]; then
      stable=$((stable+1))
      if [ "$stable" -ge 2 ]; then
        kill -9 "$pid" 2>/dev/null; pkill -9 -f yabridge 2>/dev/null
        echo "[regen]   WAV stable at $cur bytes after ${waited}s (killed teardown)"; break
      fi
    else stable=0; fi
    last="$cur"
    if [ "$waited" -ge 420 ]; then echo "[regen]   TIMEOUT ${waited}s"; kill -9 "$pid" 2>/dev/null; break; fi
  done
  wait "$pid" 2>/dev/null
}

FAIL=0
for genre in "${GENRES_ARR[@]}"; do
  echo "========== $genre =========="
  gendir="$OUT_ROOT/$genre"
  mkdir -p "$gendir"
  echo "[regen] emit-brain-roundtrip"
  ( cd "$REPO_ROOT" && SEED="$genre" OUT_DIR="apps/engine-spike/$gendir" \
      node apps/engine-spike/scripts/emit-brain-roundtrip.mjs ) >/tmp/regen-emit-$genre.log 2>&1 \
    || { echo "[regen] $genre EMIT FAILED (see /tmp/regen-emit-$genre.log)"; FAIL=1; continue; }
  echo "[regen] prestage-samples"
  ( cd "$REPO_ROOT" && BRAIN_OUT_DIR="apps/engine-spike/$gendir" \
      node apps/engine-spike/scripts/prestage-samples.mjs ) >/tmp/regen-prestage-$genre.log 2>&1 \
    || echo "[regen] $genre prestage non-zero (stub fallback may cover)"
  echo "[regen] render -> $gendir/out.wav"
  render_once "$gendir" "$gendir/out.wav" "/tmp/regen-render-$genre.log"
  sz=$(stat -c%s "$gendir/out.wav" 2>/dev/null || echo 0)
  echo "[regen] $genre out.wav = $sz bytes"
  [ "$sz" -gt 1000000 ] || { echo "[regen] $genre WAV TOO SMALL"; FAIL=1; }
  # docs/65 — export the producer-openable bundle next to out.wav. Prefer the
  # VST3-referenced edit (opens in stock Waveform once the VST3 pack is installed);
  # fall back to the built-in edit when the rewrite was skipped. Both are saved in
  # the JUCE temp dir and overwritten per genre, so bundle NOW before the next render.
  EDIT_DIR="$HOME/.config/CasperakiSpike/Temporary/casperaki"
  EDIT="$EDIT_DIR/edit-vst3.trkedit"
  [ -f "$EDIT" ] || EDIT="$EDIT_DIR/edit.trkedit"
  if [ -f "$EDIT" ]; then
    echo "[regen] bundling $(basename "$EDIT")"
    python3 scripts/export-edit-bundle.py "$EDIT" "$gendir/casperaki.zip" \
      | sed 's/^/[regen] /' || echo "[regen] $genre bundle had MISSING samples"
  else
    echo "[regen] $genre: no edit to bundle"
  fi
done

echo "[regen] === DONE (fail=$FAIL) ==="
ls -la "$OUT_ROOT"/*/out.wav 2>/dev/null
exit "$FAIL"
