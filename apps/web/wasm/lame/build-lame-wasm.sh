#!/usr/bin/env bash
# Build LAME 3.100 (the MP3 encoder, LGPL-2.0-or-later) to WebAssembly for the
# browser's mix export: public/wasm/lame.wasm (+ its licence next to it).
#
# LAME is compiled from its official source tarball (pinned by SHA-256) with
# emsdk, plus our wrapper lame_wrap.c. It is a module of its own, loaded
# separately from the engine (engine-render.wasm never links it), so anyone can
# swap in their own build of LAME: LGPL section 6. The tarball is downloaded and
# built in a cache directory outside the repo (LAME_BUILD_DIR, default
# ~/.cache/casperaki-lame): inside apps/web, whose package.json says
# "type": "module", node would refuse to run configure's test programs.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v emcc >/dev/null 2>&1; then
  # shellcheck disable=SC1090
  source "${EMSDK_ENV:-$HOME/emsdk/emsdk_env.sh}"
fi

VERSION=3.100
SHA256=ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e
URL="https://downloads.sourceforge.net/project/lame/lame/${VERSION}/lame-${VERSION}.tar.gz"
BUILD="${LAME_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/casperaki-lame}"
SRC="$BUILD/lame-${VERSION}"
OUT_DIR="../../public/wasm"
mkdir -p "$BUILD" "$OUT_DIR"

TARBALL="$BUILD/lame-${VERSION}.tar.gz"
if [ ! -f "$TARBALL" ]; then
  curl -fsSL --retry 3 -o "$TARBALL.part" "$URL"
  mv "$TARBALL.part" "$TARBALL"
fi
echo "$SHA256  $TARBALL" | sha256sum -c -

if [ ! -f "$SRC/config.h" ]; then
  rm -rf "$SRC"
  tar -xzf "$TARBALL" -C "$BUILD"
  # Only config.h is used; the build below compiles the library sources directly.
  (cd "$SRC" && emconfigure ./configure --disable-shared --enable-static --disable-frontend \
     --disable-decoder --disable-gtktest --disable-analyzer-hooks >"$BUILD/configure.log" 2>&1) \
    || { echo "LAME configure failed, see $BUILD/configure.log" >&2; exit 1; }
fi

emcc lame_wrap.c "$SRC"/libmp3lame/*.c \
  -O3 \
  -DHAVE_CONFIG_H -I"$SRC" -I"$SRC/include" -I"$SRC/libmp3lame" \
  -Wno-shift-negative-value -Wno-absolute-value \
  -o "$OUT_DIR/lame.wasm" \
  -sSTANDALONE_WASM=1 \
  --no-entry \
  -sEXPORTED_FUNCTIONS=_mp3_init,_mp3_input_frames,_mp3_input_left,_mp3_input_right,_mp3_output,_mp3_encode,_mp3_flush,_mp3_tag,_mp3_close \
  -sALLOW_MEMORY_GROWTH=0 \
  -sINITIAL_MEMORY=33554432 \
  -sTOTAL_STACK=1048576 \
  -sERROR_ON_UNDEFINED_SYMBOLS=1

cp "$SRC/COPYING" "$OUT_DIR/lame.COPYING.txt"
echo "built $OUT_DIR/lame.wasm ($(stat -c%s "$OUT_DIR/lame.wasm") bytes) from LAME $VERSION ($URL)"
