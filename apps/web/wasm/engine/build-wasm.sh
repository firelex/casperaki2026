#!/usr/bin/env bash
# Build the resolution engine to WASM for the browser (docs/60 Phase 1).
# Emits an embind module (resolveSong) the main thread calls to turn song.json
# + inst-N.json into resolved-events/v1 JSON. This is the resolution half; the
# import-free standalone DSP module (tone.c lineage) stays separate.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v emcc >/dev/null 2>&1; then
  # shellcheck disable=SC1090
  source "${EMSDK_ENV:-$HOME/emsdk/emsdk_env.sh}"
fi

OUT_DIR="../../public/wasm"
mkdir -p "$OUT_DIR"

emcc src/main_wasm.cpp \
  -O3 -std=c++17 \
  -lembind \
  -o "$OUT_DIR/engine-resolve.js" \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=createResolveEngine \
  -sENVIRONMENT=web,worker \
  -sALLOW_MEMORY_GROWTH=1 \
  -sERROR_ON_UNDEFINED_SYMBOLS=1

echo "built $OUT_DIR/engine-resolve.{js,wasm}"
ls -l "$OUT_DIR"/engine-resolve.* 2>/dev/null || true

# --- engine-render: the streaming mixer (sampler/mix half) -------------------
# STANDALONE wasm (no JS glue) so an AudioWorkletProcessor can instantiate the
# raw bytes directly (the /wasm-tone path). Native wasm exceptions keep the
# resolver's try/catch working with no JS-glue imports.
#
# Memory growth is ON (docs/60 Phase 1 finish): the REAL multisample library is
# tens of MB of decoded PCM per genre — far past the 128 MB floor for a dense
# genre — so the heap must be able to grow while JS stages samples. This is safe
# for the live L/R views: ALL allocation (mixer_set_sample[_id] staging +
# mixer_build) happens in the worklet constructor BEFORE mixer_left()/right() are
# read, and the per-quantum mixer_pull never allocates (preallocated voice pool),
# so no growth — hence no view detach — can occur once playback starts. JS reads
# e.memory.buffer fresh after each malloc while staging, so a mid-staging growth
# is fine too.
# The AirWindows FX TUs (Phase 2 Scope C) + BespokeFx are compiled into the render
# module so the MixGraph's rack chains link in the browser too. KISS FFT (BSD-3)
# is for the matched mastering (audio/Matchering.h: master_* and live_* exports);
# it is C, so it is compiled on its own (emcc rejects -std=c++17 for a .c file).
KISS_OBJ="$(mktemp -d)/kiss_fft.o"
emcc -O3 -c vendor/kissfft/kiss_fft.c -o "$KISS_OBJ"
emcc src/main_render_wasm.cpp src/audio/airwindows/*.aw.cpp src/audio/airwindows/BespokeFx.cpp src/audio/airwindows/SimpleSide.cpp src/audio/airwindows/FreqShiftEcho.cpp "$KISS_OBJ" \
  -O3 -std=c++17 \
  -fwasm-exceptions \
  -o "$OUT_DIR/engine-render.wasm" \
  -sSTANDALONE_WASM=1 \
  --no-entry \
  -sEXPORTED_FUNCTIONS=_mixer_config,_mixer_set_sample,_mixer_set_sample_id,_mixer_build,_mixer_last_error,_mixer_set_master_gain,_mixer_set_mix_enabled,_mixer_set_mastering,_mixer_set_mix_config,_mixer_seek,_mixer_position,_mixer_last_error_message,_mixer_lane_count,_mixer_lane_name,_mixer_lane_name_length,_mixer_lane_info,_mixer_lane_info_length,_mixer_set_lane_gain,_mixer_set_lane_trim,_mixer_set_lane_send,_mixer_set_bus_param,_mixer_enable_meters,_mixer_meter_bin_count,_mixer_lane_peaks,_mixer_bus_peaks,_mixer_set_probe,_mixer_probe_read,_mixer_probe_buffer,_mixer_probe_rings,_mixer_impulse,_mixer_probe_spectrum_buffer,_mixer_lane_rms,_mixer_pull,_mixer_left,_mixer_right,_mixer_total_frames,_mixer_sample_rate,_master_analyze,_master_profile_bytes,_master_profile_bytes_length,_master_apply,_master_output_frames,_master_output_left,_master_output_right,_master_release,_mixer_set_live_mastering,_live_latency_frames,_live_matched,_live_position,_live_pull,_live_seek,_live_set_loop,_live_set_profile,_malloc,_free \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=134217728 \
  -sMAXIMUM_MEMORY=1073741824 \
  -sTOTAL_STACK=8388608 \
  -sERROR_ON_UNDEFINED_SYMBOLS=1

echo "built $OUT_DIR/engine-render.wasm ($(stat -c%s "$OUT_DIR/engine-render.wasm" 2>/dev/null || echo '?') bytes)"
