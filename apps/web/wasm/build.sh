#!/usr/bin/env bash
# Phase 0 (docs/60) — compile the bespoke WASM DSP spike with Emscripten.
# Standalone WASM (no JS glue, no entry point) so an AudioWorkletProcessor can
# WebAssembly.instantiate() the raw bytes with an empty import object.
set -euo pipefail
cd "$(dirname "$0")"

# Source emsdk env if emcc is not already on PATH.
if ! command -v emcc >/dev/null 2>&1; then
  # shellcheck disable=SC1090
  source "${EMSDK_ENV:-$HOME/emsdk/emsdk_env.sh}"
fi

OUT_DIR="../public/wasm"
mkdir -p "$OUT_DIR"

emcc tone.c \
  -O3 \
  -o "$OUT_DIR/engine-tone.wasm" \
  -sSTANDALONE_WASM=1 \
  --no-entry \
  -sEXPORTED_FUNCTIONS=_dsp_init,_dsp_left,_dsp_right,_dsp_max_frames,_dsp_render \
  -sALLOW_MEMORY_GROWTH=0 \
  -sINITIAL_MEMORY=1048576 \
  -sTOTAL_STACK=262144 \
  -sERROR_ON_UNDEFINED_SYMBOLS=1

echo "built $OUT_DIR/engine-tone.wasm ($(stat -c%s "$OUT_DIR/engine-tone.wasm") bytes)"
