#!/usr/bin/env bash
# docs/65 — build the Casperaki VST3s (and AU) on macOS. Run this ON A MAC with
# Xcode Command Line Tools + CMake installed. Produces a universal (arm64 +
# x86_64) plugin set the producer drops into ~/Library/Audio/Plug-Ins/.
#
#   xcode-select --install                 # once (Apple Clang + macOS SDK)
#   brew install cmake                      # once
#   git clone --branch 8.0.6 https://github.com/juce-framework/JUCE ~/JUCE
#   JUCE_DIR=~/JUCE bash apps/casperaki-vst3/build-mac.sh
#
# Env:
#   JUCE_DIR   path to a JUCE 8.0.6 checkout (required if not auto-found)
#   ARCHS      CMAKE_OSX_ARCHITECTURES (default "arm64;x86_64")
#   FORMATS    plugin formats (default "VST3;AU")
set -euo pipefail
cd "$(dirname "$0")"

JUCE_DIR="${JUCE_DIR:-$HOME/JUCE}"
ARCHS="${ARCHS:-arm64;x86_64}"
FMT="${FORMATS:-VST3;AU}"

[ -f "$JUCE_DIR/CMakeLists.txt" ] || { echo "JUCE not found at JUCE_DIR=$JUCE_DIR — set JUCE_DIR=/path/to/JUCE"; exit 1; }
command -v cmake >/dev/null || { echo "cmake not found — brew install cmake"; exit 1; }

echo "[mac] JUCE=$JUCE_DIR  archs=$ARCHS  formats=$FMT"
cmake -S . -B build-mac \
  -DCASPERAKI_JUCE_DIR="$JUCE_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES="$ARCHS" \
  -DCASPERAKI_VST3_FORMATS="$FMT"
cmake --build build-mac --config Release -j"$(sysctl -n hw.ncpu)"

echo "[mac] built plugins:"
find build-mac -name '*.vst3' -o -name '*.component' | sed 's/^/  /'
echo
echo "Install:  cp -R build-mac/*_artefacts/Release/VST3/*.vst3       ~/Library/Audio/Plug-Ins/VST3/"
echo "          cp -R build-mac/*_artefacts/Release/AU/*.component     ~/Library/Audio/Plug-Ins/Components/   # if AU built"
echo "Gatekeeper (local use): codesign --force --deep -s - ~/Library/Audio/Plug-Ins/VST3/Casperaki*.vst3"
echo "Then rescan plugins in your DAW."
