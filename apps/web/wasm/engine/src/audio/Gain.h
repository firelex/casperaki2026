// Faithful ports of the tracktion/juce gain helpers CasperakiSamplerPlugin uses
// to turn (gainDb, velocity, pan) into per-channel linear gains, plus the MIDI
// note→Hz used for the resample ratio. Transcribed from
// tracktion_AudioUtilities.cpp (volScaleFactor=20; default pan law = Linear) and
// juce::MidiMessage::getMidiNoteInHertz.
//
// Note on the fader dance: decibelsToVolumeFaderPosition then
// volumeFaderPositionToGain compose to the identity dB→gain (the +6/-6 and the
// volScaleFactor cancel), so a voice's linear gain is simply
// 10^(effectiveDb/20). We keep the two-step form for faithfulness but the
// collapse is asserted in the audio unit test.
#pragma once

#include <cmath>

namespace casperaki {

// PanLaw values match tracktion's enum (stored in edits); we only need Linear
// (the runtime default) for Phase 1's centred voices, but keep the others for
// fidelity if a pan is ever non-zero.
enum class PanLaw { Linear, C2point5dB, C3dB, C4point5dB, C6dB };
constexpr PanLaw kDefaultPanLaw = PanLaw::Linear;

inline float midiNoteInHertz(int noteNumber, float frequencyOfA = 440.0f) {
    return frequencyOfA * std::pow(2.0f, (static_cast<float>(noteNumber) - 69.0f) / 12.0f);
}

constexpr float kVolScaleFactor = 20.0f;

inline float decibelsToVolumeFaderPosition(float db) {
    return (db > -100.0f) ? std::exp((db - 6.0f) * (1.0f / kVolScaleFactor)) : 0.0f;
}

inline float volumeFaderPositionToGain(float pos) {
    return (pos > 0.0f)
               ? std::pow(10.0f, ((kVolScaleFactor * std::log(pos)) + 6.0f) * (1.0f / 20.0f))
               : 0.0f;
}

// getGainsFromVolumeFaderPositionAndPan (tracktion_AudioUtilities.cpp). Linear
// law: leftGain = gain - pan*gain, rightGain = gain + pan*gain. Sin-power laws
// raise the half-pi sin curve to a per-law exponent and multiply by gain.
inline void getGainsFromVolumeFaderPositionAndPan(float volSliderPos, float pan, PanLaw law,
                                                  float& leftGain, float& rightGain) {
    const float gain = volumeFaderPositionToGain(volSliderPos);

    if (law == PanLaw::Linear) {
        const float pv = pan * gain;
        leftGain = gain - pv;
        rightGain = gain + pv;
        return;
    }

    const float halfPi = 3.14159265358979323846f * 0.5f;
    const float p = (pan + 1.0f) * 0.5f;
    float l = std::sin((1.0f - p) * halfPi);
    float r = std::sin(p * halfPi);

    float ratio = 1.0f;
    switch (law) {
        case PanLaw::C3dB:        ratio = 1.0f; break;
        case PanLaw::C2point5dB:  ratio = 2.5f / 3.0f; break;
        case PanLaw::C4point5dB:  ratio = 1.5f; break;
        case PanLaw::C6dB:        ratio = 2.0f; break;
        case PanLaw::Linear:      break; // handled above
    }
    leftGain = std::pow(l, ratio) * gain;
    rightGain = std::pow(r, ratio) * gain;
}

// The exact gain chain a SampledNote applies: gainDb attenuated by velocity, run
// through the fader→gain mapping and the pan law. velocity is the engine's
// hardcoded 0.75 (CasperakiSamplerPlugin.cpp:281,362) — the humanized MIDI
// velocity never reaches voice gain.
inline void sampledNoteGains(float gainDb, float velocity, float pan, float& leftGain,
                             float& rightGain) {
    const float volSliderPos = decibelsToVolumeFaderPosition(gainDb - (20.0f * (1.0f - velocity)));
    getGainsFromVolumeFaderPositionAndPan(volSliderPos, pan, kDefaultPanLaw, leftGain, rightGain);
}

} // namespace casperaki
