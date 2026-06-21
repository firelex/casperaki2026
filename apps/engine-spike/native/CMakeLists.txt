# Phase 1 (post 55a/55b/55c) — engine-spike native render harness.
#
# Builds the engine console app against an external JUCE 8.0.6 +
# Tracktion v3.2.0 checkout. The legacy pinned (JUCE 7.0.5 / Tracktion
# ~Nov-2023) stack was retired here in docs/55d-modernization-landing.md;
# the patched engine source still drives setSong() →
# exportSongWithoutMelody(). The parameterised structure originated as
# `apps/engine-spike/native55a/CMakeLists.txt` (docs/55a/55b/55c) and
# was folded back into this file as the new default.
#
# Inputs (set via -D on the cmake command line OR via the matching env
# vars below; explicit -D wins):
#   SPIKE55_JUCE_DIR        absolute path to a JUCE 8.x checkout
#                           (containing CMakeLists.txt at its root).
#                           Defaults to env CASPERAKI_JUCE_DIR or
#                           /home/roli79/apps/spike55a/deps/juce_8.0.6.
#   SPIKE55_TRACKTION_DIR   absolute path to a tracktion_engine v3.2+
#                           checkout. Defaults to env
#                           CASPERAKI_TRACKTION_DIR or
#                           /home/roli79/apps/spike55a/deps/tracktion_v3.2.0.
#   SPIKE55_TRACKTION_HAS_JUCE  set ON if the Tracktion checkout's
#                           top-level CMakeLists.txt adds
#                           `add_subdirectory(modules/juce)` itself
#                           (the v3.2.0 layout does — `modules/juce` is
#                           typically a symlink/submodule to JUCE 8.0.6).
#                           When OFF (e.g. the pinned legacy layout)
#                           we add SPIKE55_JUCE_DIR ourselves. Defaults
#                           to ON.

cmake_minimum_required(VERSION 3.22)
project(casperaki_engine_spike VERSION 0.2.0 LANGUAGES C CXX)

# Tracktion v3.2 is a C++20 codebase (uses `using enum`, `std::span`,
# `std::ranges`, `std::erase_if`). Engine source compiles under C++20
# too — docs/55a §"Engine source porting required".
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(SPIKE_ROOT ${CMAKE_CURRENT_SOURCE_DIR})

# docs/65 — the engine source defaults to the in-monorepo JSON-parity COPY
# (apps/native-engine), which loads casperaki_engine/config/mix-config.json at
# runtime. The frozen standalone ~/apps/casperaki_engine remains the parity
# ORACLE; build it by overriding -DSPIKE_ENGINE_ROOT=<path> or env
# CASPERAKI_ENGINE_ROOT. Heavy vendored dirs (VST_SDK/, dependencies/, assets/,
# ExternalPlugins/) are present on disk in the copy but gitignored in the monorepo.
if(NOT DEFINED SPIKE_ENGINE_ROOT)
  if(DEFINED ENV{CASPERAKI_ENGINE_ROOT} AND NOT "$ENV{CASPERAKI_ENGINE_ROOT}" STREQUAL "")
    set(SPIKE_ENGINE_ROOT "$ENV{CASPERAKI_ENGINE_ROOT}")
  else()
    set(SPIKE_ENGINE_ROOT "${SPIKE_ROOT}/../../native-engine")
  endif()
endif()
set(ENGINE_ROOT ${SPIKE_ENGINE_ROOT})
set(ENGINE_SRC ${ENGINE_ROOT}/Source)
set(LEGACY_DEPS ${ENGINE_ROOT}/dependencies)
message(STATUS "engine-spike: engine source @ ${ENGINE_ROOT}")

# Shared, JUCE-free FX DSP (the WASM render engine's airwindows dir). The native
# CasperakiFreqShiftEcho/SimpleSide plugins wrap this SAME source so the native
# delay/pump match the WASM render exactly (docs/63 §6 Valhalla/SimpleSide retirement).
set(WASM_FX_DIR ${SPIKE_ROOT}/../../web/wasm/engine/src/audio/airwindows)

# Matchering port — sibling sibling-of-engine repo at apps/matchering. All
# headers are inline (commit 8b801f8); only the include path + the two
# binary-data assets (atemlos.json, referenceAtemlos.wav) need wiring.
# Override via -DSPIKE55_MATCHERING_DIR=<path> or env CASPERAKI_MATCHERING_DIR.
if(NOT DEFINED SPIKE55_MATCHERING_DIR)
  if(DEFINED ENV{CASPERAKI_MATCHERING_DIR} AND NOT "$ENV{CASPERAKI_MATCHERING_DIR}" STREQUAL "")
    set(SPIKE55_MATCHERING_DIR "$ENV{CASPERAKI_MATCHERING_DIR}")
  else()
    set(SPIKE55_MATCHERING_DIR "${SPIKE_ROOT}/../../../../matchering")
  endif()
endif()
if(NOT EXISTS "${SPIKE55_MATCHERING_DIR}/Source/Matchering.h")
  message(FATAL_ERROR
    "matchering checkout not found at ${SPIKE55_MATCHERING_DIR}.\n"
    "Set -DSPIKE55_MATCHERING_DIR=<path> or env CASPERAKI_MATCHERING_DIR.")
endif()
message(STATUS "engine-spike: matchering @ ${SPIKE55_MATCHERING_DIR}")

# Defaults — overridable via -D or matching env var. Documented in the
# header above. The env defaults match this dev box's spike55a tree.
if(NOT DEFINED SPIKE55_TRACKTION_DIR)
  if(DEFINED ENV{CASPERAKI_TRACKTION_DIR} AND NOT "$ENV{CASPERAKI_TRACKTION_DIR}" STREQUAL "")
    set(SPIKE55_TRACKTION_DIR "$ENV{CASPERAKI_TRACKTION_DIR}")
  else()
    set(SPIKE55_TRACKTION_DIR "/home/roli79/apps/spike55a/deps/tracktion_v3.2.0")
  endif()
endif()
if(NOT DEFINED SPIKE55_JUCE_DIR)
  if(DEFINED ENV{CASPERAKI_JUCE_DIR} AND NOT "$ENV{CASPERAKI_JUCE_DIR}" STREQUAL "")
    set(SPIKE55_JUCE_DIR "$ENV{CASPERAKI_JUCE_DIR}")
  else()
    set(SPIKE55_JUCE_DIR "/home/roli79/apps/spike55a/deps/juce_8.0.6")
  endif()
endif()
if(NOT DEFINED SPIKE55_TRACKTION_HAS_JUCE)
  set(SPIKE55_TRACKTION_HAS_JUCE ON)
endif()

if(NOT EXISTS "${SPIKE55_TRACKTION_DIR}/CMakeLists.txt")
  message(FATAL_ERROR
    "tracktion checkout not found at ${SPIKE55_TRACKTION_DIR}.\n"
    "Set -DSPIKE55_TRACKTION_DIR=<path> or env CASPERAKI_TRACKTION_DIR.")
endif()
if(NOT SPIKE55_TRACKTION_HAS_JUCE AND NOT EXISTS "${SPIKE55_JUCE_DIR}/CMakeLists.txt")
  message(FATAL_ERROR
    "juce checkout not found at ${SPIKE55_JUCE_DIR}.\n"
    "Set -DSPIKE55_JUCE_DIR=<path> or env CASPERAKI_JUCE_DIR, or set "
    "SPIKE55_TRACKTION_HAS_JUCE=ON if the tracktion checkout bundles juce.")
endif()

message(STATUS "engine-spike: tracktion @ ${SPIKE55_TRACKTION_DIR}")
message(STATUS "engine-spike: juce      @ ${SPIKE55_JUCE_DIR}")
message(STATUS "engine-spike: tracktion-bundled-juce = ${SPIKE55_TRACKTION_HAS_JUCE}")

if(SPIKE55_TRACKTION_HAS_JUCE)
  add_subdirectory(${SPIKE55_TRACKTION_DIR} tracktion_engine_build EXCLUDE_FROM_ALL)
else()
  add_subdirectory(${SPIKE55_JUCE_DIR} juce_build EXCLUDE_FROM_ALL)
  add_subdirectory(${SPIKE55_TRACKTION_DIR} tracktion_engine_build EXCLUDE_FROM_ALL)
endif()

set(CHOC_INCLUDE ${LEGACY_DEPS}/choc)

# The engine's compile group: build the C++ files Projucer would have
# compiled. Mirrors the LinuxApp.jucer compile=1 set, minus the GUI/UI
# .cpp files.
set(ENGINE_SOURCES
  ${ENGINE_SRC}/CasperakiEngine.cpp
  ${ENGINE_SRC}/CasperakiSamplerPlugin.cpp
  ${ENGINE_SRC}/sequencer/Sequencer.cpp
  ${ENGINE_SRC}/instruments/Instrument.cpp
  ${ENGINE_SRC}/instruments/SamplesDownloadTask.cpp
  ${ENGINE_SRC}/instruments/mp3decode/wave/wave.cpp
  # Casperaki-bundled Airwindows ports — 10 plugins not in Tracktion's
  # AIRWINDOWSPLUGIN snapshot (Console8 Sub/Buss In/Out, kPlateA, kPlateD,
  # TexturizeMS, StereoChorus, Huge, Air2). Replaces the Consolidated VST3
  # path for these so legacy chunk state deserialises natively.
  ${ENGINE_SRC}/airwindows_extras/CasperakiAirwindowsExtras.cpp
  # In-tree replacements for the two RETIRED external VSTs (docs/63 §6):
  # ValhallaFreqEcho (Wine/yabridge) + SimpleSide (GPLv3). The wrapper is in
  # casperaki_engine; the DSP is shared verbatim from the WASM engine tree.
  ${ENGINE_SRC}/casperaki_fx/CasperakiFxPlugins.cpp
  ${WASM_FX_DIR}/FreqShiftEcho.cpp
  ${WASM_FX_DIR}/SimpleSide.cpp)

# 55b fix (load-bearing — see docs/55b-tracktion3-guitar-silence.md):
# PRODUCT_NAME MUST match the legacy build so JUCE resolves the same
# `~/.config/CasperakiSpike/Temporary/` cache. A distinct PRODUCT_NAME
# would pre-stage samples to a different dir; the stub server's 58-byte
# fallback would cache silently and every render would play digital
# silence on chord-strum slots.
juce_add_console_app(casperaki_spike
  PRODUCT_NAME "CasperakiSpike"
  COMPANY_NAME "Casperaki")

juce_generate_juce_header(casperaki_spike)

# Embed binary assets:
#   ChordData.json          — engine's Chord.h finds BinaryData::ChordData_json
#   atemlos.json            — matchering Matcherer ctor reads
#                             BinaryData::atemlos_json (FIR coefficients)
#   referenceAtemlos.wav    — matchering masterSongAtemlos uses
#                             BinaryData::referenceAtemlos_wav as the
#                             baked-in mastering reference (38 MB — bloats
#                             the binary; matches the legacy build).
juce_add_binary_data(casperaki_spike_assets
  HEADER_NAME BinaryData.h
  SOURCES
    ${ENGINE_SRC}/music/ChordData.json
    ${SPIKE55_MATCHERING_DIR}/Source/atemlos.json
    ${ENGINE_ROOT}/assets/referenceAtemlos.wav)

target_sources(casperaki_spike PRIVATE
  ${SPIKE_ROOT}/harness.cpp
  ${SPIKE_ROOT}/matchering_postprocess.cpp
  ${ENGINE_SOURCES})

target_include_directories(casperaki_spike PRIVATE
  ${SPIKE_ROOT}/include-shim
  ${ENGINE_SRC}
  ${ENGINE_SRC}/instruments
  ${ENGINE_SRC}/sequencer
  ${ENGINE_SRC}/music
  ${ENGINE_SRC}/instruments/mp3decode
  ${SPIKE55_MATCHERING_DIR}/Source
  ${CHOC_INCLUDE}
  # AwPlugins.h for CasperakiFxPlugins.cpp + the shared FreqShiftEcho/SimpleSide DSP.
  ${WASM_FX_DIR})

# Scope the C++ prelude to C++ TUs only — JUCE 8 vendors SheenBidi as
# C files, which would otherwise see a `#include <cmath>` they can't
# parse (docs/55a path B).
target_compile_options(casperaki_spike PRIVATE
  "$<$<COMPILE_LANGUAGE:CXX>:SHELL:-include ${SPIKE_ROOT}/include-shim/spike_prelude.h>"
  -Wno-error)

target_compile_definitions(casperaki_spike PRIVATE
  JUCE_USE_MP3AUDIOFORMAT=1
  JUCE_USE_CURL=1
  JUCE_WEB_BROWSER=0
  JUCE_DISPLAY_SPLASH_SCREEN=0
  JUCE_USE_DARK_SPLASH_SCREEN=0
  JUCE_STRICT_REFCOUNTEDPOINTER=1
  JUCE_MODAL_LOOPS_PERMITTED=1
  # docs/57d — activate the PRESET_BALLAD_* airwindows-bearing branch in
  # PresetManager.h (gated by JUCE_PLUGINHOST_VST). Also enable VST3 + LV2
  # hosting so the rack-XML remap can route to Airwindows Consolidated +
  # SimpleSide. TRACKTION_AIR_WINDOWS=1 brings the Tracktion-internal
  # AirWindows DSP into the build for the 6-of-16 overlap plugins.
  JUCE_PLUGINHOST_VST=1
  JUCE_PLUGINHOST_VST3=1
  JUCE_PLUGINHOST_LV2=1
  JUCE_PLUGINHOST_AU=0
  TRACKTION_AIR_WINDOWS=1
  JUCE_APP_VERSION=1.0.0
  JUCE_APP_VERSION_HEX=0x10000)

target_include_directories(casperaki_spike PRIVATE
  ${ENGINE_ROOT}/VST_SDK/VST2_SDK)

find_package(CURL REQUIRED)

target_link_libraries(casperaki_spike PRIVATE
  casperaki_spike_assets
  CURL::libcurl
  atomic
  tracktion::tracktion_engine
  tracktion::tracktion_graph
  juce::juce_audio_basics
  juce::juce_audio_devices
  juce::juce_audio_formats
  juce::juce_audio_processors
  juce::juce_audio_utils
  juce::juce_core
  juce::juce_data_structures
  juce::juce_dsp
  juce::juce_events
  juce::juce_graphics
  juce::juce_gui_basics
  juce::juce_gui_extra
  juce::juce_osc
  juce::juce_recommended_config_flags
  juce::juce_recommended_warning_flags)

# ---------------------------------------------------------------------------
# Plugin-hosting smoke binary (docs/57b-plugin-hosting-smoke.md).
#
# Independent JUCEApplication target. Constructs a default tracktion::Engine
# and instantiates the 6 Airwindows plugins that Tracktion 3.2 ships as
# built-in types and that the legacy rack chain references (Pyewacket, EQ,
# Logical 4, NC-17, Thunder, ADClip 7). Runs a known noise buffer through
# Pyewacket and reports per-plugin instantiation + processing divergence.
# Does NOT link the engine source set — it talks to Tracktion directly so a
# smoke failure can't take the spike with it. JUCE_PLUGINHOST_VST3 / LV2 are
# enabled HERE ONLY (not on casperaki_spike), so the production render
# binary's flag set is unchanged in this slice.
# ---------------------------------------------------------------------------
juce_add_console_app(casperaki_plugin_smoke
  PRODUCT_NAME "CasperakiPluginSmoke"
  COMPANY_NAME "Casperaki")

juce_generate_juce_header(casperaki_plugin_smoke)

target_sources(casperaki_plugin_smoke PRIVATE
  ${SPIKE_ROOT}/plugin_smoke.cpp)

target_include_directories(casperaki_plugin_smoke PRIVATE
  ${SPIKE_ROOT}/include-shim)

target_compile_options(casperaki_plugin_smoke PRIVATE
  "$<$<COMPILE_LANGUAGE:CXX>:SHELL:-include ${SPIKE_ROOT}/include-shim/spike_prelude.h>"
  -Wno-error)

target_compile_definitions(casperaki_plugin_smoke PRIVATE
  JUCE_PLUGINHOST_VST3=1
  JUCE_PLUGINHOST_LV2=1
  # VST2 hosting enabled so the smoke can probe yabridge proxies for
  # legacy Windows VST2 plugins (e.g. ValhallaFreqEcho — see docs/57c).
  # Requires the VST2 SDK headers under ${LEGACY_DEPS}/VST_SDK/VST2_SDK/
  # which the existing casperaki_engine sibling repo ships.
  JUCE_PLUGINHOST_VST=1
  JUCE_PLUGINHOST_AU=0
  JUCE_USE_CURL=0
  JUCE_WEB_BROWSER=0
  JUCE_STRICT_REFCOUNTEDPOINTER=1
  JUCE_MODAL_LOOPS_PERMITTED=1
  TRACKTION_AIR_WINDOWS=1
  JUCE_APP_VERSION=1.0.0
  JUCE_APP_VERSION_HEX=0x10000)

target_include_directories(casperaki_plugin_smoke PRIVATE
  ${ENGINE_ROOT}/VST_SDK/VST2_SDK)

target_link_libraries(casperaki_plugin_smoke PRIVATE
  atomic
  tracktion::tracktion_engine
  tracktion::tracktion_graph
  juce::juce_audio_basics
  juce::juce_audio_devices
  juce::juce_audio_formats
  juce::juce_audio_processors
  juce::juce_audio_utils
  juce::juce_core
  juce::juce_data_structures
  juce::juce_dsp
  juce::juce_events
  juce::juce_graphics
  juce::juce_gui_basics
  juce::juce_gui_extra
  juce::juce_osc
  juce::juce_recommended_config_flags
  juce::juce_recommended_warning_flags)

# ---------------------------------------------------------------------------
# Matchering smoke binary — drives the matchering post-process standalone
# (no Tracktion render, no asset server). Takes an existing WAV and runs
# masterSongAtemlos against the embedded referenceAtemlos.wav. Used to
# validate the port in isolation from the render pipeline.
# ---------------------------------------------------------------------------
juce_add_console_app(casperaki_matchering_smoke
  PRODUCT_NAME "CasperakiMatcheringSmoke"
  COMPANY_NAME "Casperaki")

juce_generate_juce_header(casperaki_matchering_smoke)

target_sources(casperaki_matchering_smoke PRIVATE
  ${SPIKE_ROOT}/matchering_smoke.cpp
  ${SPIKE_ROOT}/matchering_postprocess.cpp)

target_include_directories(casperaki_matchering_smoke PRIVATE
  ${SPIKE_ROOT}/include-shim
  ${SPIKE55_MATCHERING_DIR}/Source)

target_compile_options(casperaki_matchering_smoke PRIVATE
  "$<$<COMPILE_LANGUAGE:CXX>:SHELL:-include ${SPIKE_ROOT}/include-shim/spike_prelude.h>"
  -Wno-error)

target_compile_definitions(casperaki_matchering_smoke PRIVATE
  JUCE_USE_MP3AUDIOFORMAT=1
  JUCE_USE_CURL=0
  JUCE_WEB_BROWSER=0
  JUCE_STRICT_REFCOUNTEDPOINTER=1
  JUCE_MODAL_LOOPS_PERMITTED=1
  JUCE_APP_VERSION=1.0.0
  JUCE_APP_VERSION_HEX=0x10000)

target_link_libraries(casperaki_matchering_smoke PRIVATE
  casperaki_spike_assets
  atomic
  juce::juce_audio_basics
  juce::juce_audio_devices
  juce::juce_audio_formats
  juce::juce_audio_processors
  juce::juce_audio_utils
  juce::juce_core
  juce::juce_data_structures
  juce::juce_dsp
  juce::juce_events
  juce::juce_graphics
  juce::juce_gui_basics
  juce::juce_gui_extra
  juce::juce_recommended_config_flags
  juce::juce_recommended_warning_flags)

# ---------------------------------------------------------------------------
# SimpleSide GPL3 Linux VST3 build (docs/57c §"SimpleSide — CORRECTION").
#
# Builds Armando Montanez's SimpleSide (tempo-synced drawable volume LFO)
# as a Linux VST3 from the source dropped in at external/SimpleSide/.
# Independent target — not linked into casperaki_spike or
# casperaki_plugin_smoke. The output VST3 is installed under ~/.vst3/ in
# 57d so JUCE's scanner picks it up alongside Airwindows Consolidated.
# ---------------------------------------------------------------------------
if(EXISTS "${SPIKE_ROOT}/../external/SimpleSide/CMakeLists.txt")
  add_subdirectory(${SPIKE_ROOT}/../external/SimpleSide simpleside_build
                   EXCLUDE_FROM_ALL)
endif()
