# Native build for the WASM resolution engine — used for tests and for the
# resolution oracle diff (the browser build is build-wasm.sh / emscripten).
# The engine source is portable C++17 (no JUCE, no Tracktion); the same headers
# compile under Emscripten.
#
#   cmake -S . -B build && cmake --build build
#   ./build/random_test                 # RNG determinism/parity unit test
#   ./build/casperaki_resolve <dir>     # emit resolved-events/v1 for a genre
cmake_minimum_required(VERSION 3.16)
project(casperaki_wasm_engine C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

add_executable(casperaki_resolve src/main_native.cpp)
add_executable(random_test test/random_test.cpp)
add_executable(audio_test test/audio_test.cpp)
add_executable(sampler_test test/sampler_test.cpp)

# AirWindows DSP (docs/63 §6 / Phase 2 Scope C). One namespaced TU per vendored
# AirWindows plugin (vendor/airwindows/, MIT) compiled via aw_shim.h — no JUCE/VST
# SDK. A static lib linked into every target that builds the Mixer/MixGraph.
set(AIRWINDOWS_SOURCES
    src/audio/airwindows/Console8SubIn.aw.cpp
    src/audio/airwindows/Console8SubOut.aw.cpp
    src/audio/airwindows/Console8BussIn.aw.cpp
    src/audio/airwindows/Console8BussOut.aw.cpp
    src/audio/airwindows/Air2.aw.cpp
    src/audio/airwindows/Huge.aw.cpp
    src/audio/airwindows/StereoChorus.aw.cpp
    src/audio/airwindows/TexturizeMS.aw.cpp
    src/audio/airwindows/kPlateA.aw.cpp
    src/audio/airwindows/kPlateD.aw.cpp
    src/audio/airwindows/Pyewacket.aw.cpp
    src/audio/airwindows/EQ.aw.cpp
    src/audio/airwindows/Logical4.aw.cpp
    src/audio/airwindows/NC17.aw.cpp
    src/audio/airwindows/Thunder.aw.cpp
    src/audio/airwindows/ADClip7.aw.cpp
    src/audio/airwindows/TapeDelay.aw.cpp
    src/audio/airwindows/BespokeFx.cpp
    src/audio/airwindows/SimpleSide.cpp
    src/audio/airwindows/FreqShiftEcho.cpp)
add_library(aw_fx STATIC ${AIRWINDOWS_SOURCES})
target_link_libraries(audio_test PRIVATE aw_fx)
target_link_libraries(sampler_test PRIVATE aw_fx)

# Offline render driver — the sampler/mix half. stb_vorbis (OGG) + minimp3 (MP3,
# the real library's codec) are each compiled as their own public-domain C TU
# (vendor/) and linked in for the native decode adapters (audio/AudioDecode.h).
add_library(stb_vorbis STATIC vendor/stb_vorbis.c)
target_compile_options(stb_vorbis PRIVATE -w)  # third-party: silence its warnings
add_library(minimp3 STATIC vendor/minimp3_impl.c)
target_compile_options(minimp3 PRIVATE -w)     # third-party: silence its warnings
add_executable(casperaki_render src/main_render.cpp)
target_link_libraries(casperaki_render PRIVATE stb_vorbis minimp3 aw_fx)

# Mixer probe — headless parity reference for the WASM streaming mixer. Reads stub
# PCM from a file (no OGG decode), so it links no codec.
add_executable(casperaki_mixer_probe src/main_mixer_probe.cpp)
target_link_libraries(casperaki_mixer_probe PRIVATE aw_fx)

# Real-sample integration test — decodes + slices the actual library and asserts
# known-note pitch/slice/distinctness. Links the codecs; SKIPs (passes) when the
# library isn't mounted. The ballad envelope path is injected so the test can find
# its asset-manifest.json regardless of the ctest working directory.
add_executable(realsample_test test/realsample_test.cpp)
target_link_libraries(realsample_test PRIVATE stb_vorbis minimp3 aw_fx)
target_compile_definitions(realsample_test PRIVATE
    REALSAMPLE_GENRE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../../engine-spike/out/all-genre-render-smoke/ballad")

# AirWindows DSP smoke (docs/63 §6 / Phase 2 Scope C).
add_executable(airwindows_test test/airwindows_test.cpp)
target_link_libraries(airwindows_test PRIVATE aw_fx)

# transitionNoise / fxNoiseRise riser source (docs/62 A7).
add_executable(noise_source_test test/noise_source_test.cpp)
target_link_libraries(noise_source_test PRIVATE aw_fx)

# Shared mix-config.json parity gate (docs/64) — JSON-loaded MixConfig must match
# the compiled-in MixTables.h / RackData.h exactly. Header-only (no codec/aw).
add_executable(mixconfig_test test/mixconfig_test.cpp)
target_compile_definitions(mixconfig_test PRIVATE
    MIXCONFIG_JSON_PATH="${CMAKE_CURRENT_SOURCE_DIR}/../../../../../casperaki_engine/config/mix-config.json")

# Instrument lanes: names, per-lane meters, live lane gain (mute/solo).
add_executable(lanes_test test/lanes_test.cpp)
target_link_libraries(lanes_test PRIVATE aw_fx)
target_compile_definitions(lanes_test PRIVATE
    LANES_GENRE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../../engine-spike/out/all-genre-render-smoke/latin"
    LANES_MIX_CONFIG="${CMAKE_CURRENT_SOURCE_DIR}/../../../../../casperaki_engine/config/mix-config.json")

enable_testing()
add_test(NAME random_test COMMAND random_test)
add_test(NAME audio_test COMMAND audio_test)
add_test(NAME sampler_test COMMAND sampler_test)
add_test(NAME realsample_test COMMAND realsample_test)
add_test(NAME airwindows_test COMMAND airwindows_test)
add_test(NAME noise_source_test COMMAND noise_source_test)
add_test(NAME mixconfig_test COMMAND mixconfig_test)
add_test(NAME lanes_test COMMAND lanes_test)
