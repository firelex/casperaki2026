# docs/65 — Casperaki custom FX as installable VST3s, so a producer can open the
# exported Tracktion edit in stock Waveform with every plugin resolving. One
# generic AwProcessor (AwProcessor.h) hosts the SHARED render-engine DSP
# (apps/web/wasm/engine/src/audio/airwindows, casperaki::aw::Plugin); each VST3
# target only differs by its factory + identity. Audio matches the engine's
# internal plugin because it is the same DSP source.
#
# Build:
#   cmake -S apps/casperaki-vst3 -B apps/casperaki-vst3/build -DCMAKE_BUILD_TYPE=Release
#   cmake --build apps/casperaki-vst3/build -j
# Override JUCE via -DCASPERAKI_JUCE_DIR=<path> or env CASPERAKI_JUCE_DIR.
cmake_minimum_required(VERSION 3.22)
project(casperaki_vst3 VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# --- JUCE (reuse the spike's 8.0.6 checkout; bundled VST3 SDK) ----------------
if(NOT DEFINED CASPERAKI_JUCE_DIR)
  if(DEFINED ENV{CASPERAKI_JUCE_DIR} AND NOT "$ENV{CASPERAKI_JUCE_DIR}" STREQUAL "")
    set(CASPERAKI_JUCE_DIR "$ENV{CASPERAKI_JUCE_DIR}")
  else()
    set(CASPERAKI_JUCE_DIR "/home/roli79/apps/spike55a/deps/juce_8.0.6")
  endif()
endif()
if(NOT EXISTS "${CASPERAKI_JUCE_DIR}/CMakeLists.txt")
  message(FATAL_ERROR "JUCE not found at ${CASPERAKI_JUCE_DIR}; set -DCASPERAKI_JUCE_DIR or env CASPERAKI_JUCE_DIR")
endif()
message(STATUS "casperaki-vst3: JUCE @ ${CASPERAKI_JUCE_DIR}")
add_subdirectory(${CASPERAKI_JUCE_DIR} juce_build EXCLUDE_FROM_ALL)

# --- shared, JUCE-free render DSP --------------------------------------------
set(AW_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../web/wasm/engine/src/audio/airwindows)
file(GLOB AW_DSP_SOURCES ${AW_DIR}/*.cpp)
add_library(casperaki_aw_dsp STATIC ${AW_DSP_SOURCES})
target_include_directories(casperaki_aw_dsp PUBLIC ${AW_DIR})

# Plugin formats — default VST3 (Linux/Windows); a Mac build can pass
# -DCASPERAKI_VST3_FORMATS="VST3;AU" to also build AudioUnits.
if(NOT DEFINED CASPERAKI_VST3_FORMATS)
  set(CASPERAKI_VST3_FORMATS "VST3")
endif()

# --- helper: one VST3 per effect ---------------------------------------------
# casperaki_vst3(<target> "<Product Name>" <4charCode> <factory>)
function(casperaki_vst3 TARGET DISPLAY CODE FACTORY)
  juce_add_plugin(${TARGET}
    PRODUCT_NAME "${DISPLAY}"
    COMPANY_NAME "Casperaki"
    BUNDLE_ID "com.casperaki.${TARGET}"
    PLUGIN_MANUFACTURER_CODE Cska
    PLUGIN_CODE ${CODE}
    FORMATS ${CASPERAKI_VST3_FORMATS}
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    VST3_CATEGORIES Fx
    COPY_PLUGIN_AFTER_BUILD FALSE)
  target_sources(${TARGET} PRIVATE PluginEntry.cpp)
  target_compile_definitions(${TARGET} PRIVATE
    CASP_FACTORY=${FACTORY}
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_DISPLAY_SPLASH_SCREEN=0)
  target_include_directories(${TARGET} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${AW_DIR})
  target_link_libraries(${TARGET} PRIVATE
    casperaki_aw_dsp
    juce::juce_audio_utils
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)
endfunction()

# --- the effects the exported edits reference (4-char codes unique per plugin) -
# Bespoke Casperaki FX
casperaki_vst3(CasperakiFreqShiftEcho "Casperaki FreqShiftEcho" Cfqe makeFreqShiftEcho)
casperaki_vst3(CasperakiSimpleSide    "Casperaki SimpleSide"    Csmp makeSimpleSide)
target_compile_definitions(CasperakiSimpleSide PRIVATE CASP_SIMPLESIDE=1)
# AirWindows "extras" not bundled with stock Tracktion
casperaki_vst3(CasperakiConsole8SubIn  "Casperaki Console8SubIn"  Cc8a makeConsole8SubIn)
casperaki_vst3(CasperakiConsole8SubOut "Casperaki Console8SubOut" Cc8b makeConsole8SubOut)
casperaki_vst3(CasperakiConsole8BussIn "Casperaki Console8BussIn" Cc8c makeConsole8BussIn)
casperaki_vst3(CasperakiConsole8BussOut "Casperaki Console8BussOut" Cc8d makeConsole8BussOut)
casperaki_vst3(CasperakiKPlateD        "Casperaki kPlateD"        Ckpd makeKPlateD)
casperaki_vst3(CasperakiKPlateA        "Casperaki kPlateA"        Ckpa makeKPlateA)
casperaki_vst3(CasperakiTexturizeMS    "Casperaki TexturizeMS"    Ctxm makeTexturizeMS)
casperaki_vst3(CasperakiStereoChorus   "Casperaki StereoChorus"   Csch makeStereoChorus)
casperaki_vst3(CasperakiHuge           "Casperaki Huge"           Chug makeHuge)
casperaki_vst3(CasperakiAir2           "Casperaki Air2"           Cair makeAir2)
