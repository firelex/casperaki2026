# docs/57d — Build SimpleSide as a Linux VST3 from the GPL3 source.
#
# Source dropped in from
# http://armandomontanez.com/simpleside/files/SimpleSide_release.zip
# (v1.0.1, 2017). Originally a Projucer build for macOS (.component /
# .vst / .vst3) + Windows (.dll). No CMakeLists / .jucer was bundled
# with the source release, so we author one against JUCE 8.0.6's
# juce_add_plugin / juce_generate_juce_header.
#
# Linux-only — VST3 format. AU / VST2 / standalone targets removed.
# Editor + UI components are still compiled so a host that opens the
# plugin's window can use it; for our headless render path the editor
# is never instantiated.

cmake_minimum_required(VERSION 3.22)
project(simpleside_plugin VERSION 1.0.1 LANGUAGES C CXX)

# JUCE is provided by the parent (engine-spike) build via
# add_subdirectory(SPIKE55_TRACKTION_DIR) — Tracktion 3.2 brings
# JUCE 8.0.6 along.

if(NOT TARGET juce::juce_audio_processors)
  message(FATAL_ERROR
    "SimpleSide CMakeLists expects JUCE to be configured by the parent "
    "engine-spike CMakeLists. Don't build this subdirectory standalone.")
endif()

set(SIMPLESIDE_ROOT ${CMAKE_CURRENT_SOURCE_DIR})

juce_add_plugin(SimpleSide
  PRODUCT_NAME "SimpleSide"
  COMPANY_NAME "Armando Montanez"
  PLUGIN_MANUFACTURER_CODE Amon
  PLUGIN_CODE SmSd
  BUNDLE_ID "com.armandomontanez.SimpleSide"
  VERSION 1.0.1
  FORMATS VST3
  IS_SYNTH FALSE
  NEEDS_MIDI_INPUT FALSE
  NEEDS_MIDI_OUTPUT FALSE
  IS_MIDI_EFFECT FALSE
  EDITOR_WANTS_KEYBOARD_FOCUS FALSE
  COPY_PLUGIN_AFTER_BUILD FALSE
  VST3_CATEGORIES Fx Modulation)

juce_generate_juce_header(SimpleSide)

# Embed the two PNGs referenced from the source
# (BinaryData::background_png in PluginEditor.cpp, BinaryData::Playhead_png in
# ui/CurveView.cpp). The other PNGs in Source/images/ are unused by the source.
juce_add_binary_data(SimpleSide_assets
  HEADER_NAME BinaryData.h
  NAMESPACE BinaryData
  SOURCES
    ${SIMPLESIDE_ROOT}/Source/images/background.png
    ${SIMPLESIDE_ROOT}/Source/images/Playhead.png
    ${SIMPLESIDE_ROOT}/Source/images/MixKnobFilmstrip.png
    ${SIMPLESIDE_ROOT}/Source/images/ReadoutFilmstrip.png)

target_sources(SimpleSide PRIVATE
  ${SIMPLESIDE_ROOT}/Source/PluginProcessor.cpp
  ${SIMPLESIDE_ROOT}/Source/PluginEditor.cpp
  ${SIMPLESIDE_ROOT}/Source/types/SSCurve.cpp
  ${SIMPLESIDE_ROOT}/Source/types/SSMultiCurve.cpp
  ${SIMPLESIDE_ROOT}/Source/automation/MixAutomator.cpp
  ${SIMPLESIDE_ROOT}/Source/automation/RateAutomator.cpp
  ${SIMPLESIDE_ROOT}/Source/ui/CurveView.cpp
  ${SIMPLESIDE_ROOT}/Source/ui/SSHandle.cpp
  ${SIMPLESIDE_ROOT}/Source/ui/SSMixKnob.cpp
  ${SIMPLESIDE_ROOT}/Source/ui/SSRateReadout.cpp
  ${SIMPLESIDE_ROOT}/Source/ui/VintageKnob.cpp)

target_include_directories(SimpleSide PRIVATE
  ${SIMPLESIDE_ROOT}/Source)

target_compile_definitions(SimpleSide PRIVATE
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0
  JUCE_VST3_CAN_REPLACE_VST2=0
  JUCE_STRICT_REFCOUNTEDPOINTER=1
  JUCE_DISPLAY_SPLASH_SCREEN=0)

# The 2017 source uses unqualified juce types (`String`, `AudioSampleBuffer`,
# `Point<float>`, `Component`, etc.). Each .cpp / .h has `using namespace juce;`
# injected after its include block to compile under JUCE 8 without a wholesale
# rewrite. Also `-Wno-error` so any deprecation warnings (e.g.
# AudioPlayHead::CurrentPositionInfo) don't fail the build.
target_compile_options(SimpleSide PRIVATE -Wno-error)

target_link_libraries(SimpleSide PRIVATE
  SimpleSide_assets
  juce::juce_audio_utils
  juce::juce_audio_processors
  juce::juce_gui_extra
  juce::juce_recommended_config_flags
  juce::juce_recommended_warning_flags)
