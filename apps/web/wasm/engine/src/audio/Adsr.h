// Faithful port of juce::ADSR — the envelope CasperakiSamplerPlugin's SampledNote
// runs per voice (SHOULD_APPLY_ADSR=1). Transcribed from juce_ADSR.h: the same
// four-state ramp machine (attack/decay/sustain/release) and the same
// applyEnvelopeToBuffer that multiplies every channel of a buffer region by the
// running envelope value.
//
// Parameters used by the sampler: attack 0.001 s, decay 0.1 s, sustain 1.0,
// release 2.0 s @ 44100 (CasperakiSamplerPlugin.cpp:51-52). With sustain == 1.0
// the decay stage is a no-op (decayRate resolves to 0 / instant), so a voice is
// effectively a 1 ms fade-in, a unity hold, then a 2 s release fade on noteOff.
#pragma once

#include <algorithm>

namespace casperaki {

class Adsr {
public:
    struct Parameters {
        float attack = 0.1f;   // seconds
        float decay = 0.1f;    // seconds
        float sustain = 1.0f;  // 0..1
        float release = 0.1f;  // seconds
    };

    void setSampleRate(double sr) { sampleRate_ = sr; }

    void setParameters(const Parameters& p) {
        parameters_ = p;
        sustainLevel_ = p.sustain;
        recalcRates();
    }

    void reset() {
        envelopeVal_ = 0.0f;
        state_ = State::idle;
    }

    void noteOn() {
        if (attackRate_ > 0.0f) {
            state_ = State::attack;
        } else if (decayRate_ > 0.0f) {
            envelopeVal_ = 1.0f;
            state_ = State::decay;
        } else {
            envelopeVal_ = sustainLevel_;
            state_ = State::sustain;
        }
    }

    void noteOff() {
        if (state_ != State::idle) {
            if (parameters_.release > 0.0f) {
                releaseRate_ = (float)(envelopeVal_ / (parameters_.release * sampleRate_));
                state_ = State::release;
            } else {
                reset();
            }
        }
    }

    bool isActive() const { return state_ != State::idle; }

    float getNextSample() {
        switch (state_) {
            case State::idle:
                return 0.0f;

            case State::attack: {
                envelopeVal_ += attackRate_;
                if (envelopeVal_ >= 1.0f) {
                    envelopeVal_ = 1.0f;
                    goToNextState();
                }
                return envelopeVal_;
            }

            case State::decay: {
                envelopeVal_ -= decayRate_;
                if (envelopeVal_ <= sustainLevel_) {
                    envelopeVal_ = sustainLevel_;
                    goToNextState();
                }
                return envelopeVal_;
            }

            case State::sustain:
                envelopeVal_ = sustainLevel_;
                return envelopeVal_;

            case State::release: {
                envelopeVal_ -= releaseRate_;
                if (envelopeVal_ <= 0.0f) {
                    goToNextState();
                }
                return envelopeVal_;
            }
        }
        return 0.0f;
    }

    // juce::ADSR::applyEnvelopeToBuffer — advance the envelope once per sample and
    // multiply every channel of the [startSample, startSample+numSamples) region.
    // When idle the region is zeroed (matches juce: it clears + returns).
    template <typename Buffer>
    void applyEnvelopeToBuffer(Buffer& buffer, int startSample, int numSamples) {
        if (state_ == State::idle) {
            for (int ch = 0; ch < buffer.getNumChannels(); ++ch) {
                float* d = buffer.getWritePointer(ch, startSample);
                for (int i = 0; i < numSamples; ++i) d[i] = 0.0f;
            }
            return;
        }

        const int numChannels = buffer.getNumChannels();
        for (int i = 0; i < numSamples; ++i) {
            const float env = getNextSample();
            for (int ch = 0; ch < numChannels; ++ch)
                buffer.getWritePointer(ch, startSample)[i] *= env;
        }
    }

private:
    enum class State { idle, attack, decay, sustain, release };

    void goToNextState() {
        if (state_ == State::attack) {
            state_ = (decayRate_ > 0.0f) ? State::decay : State::sustain;
            if (state_ == State::sustain) envelopeVal_ = sustainLevel_;
            return;
        }
        if (state_ == State::decay) { state_ = State::sustain; return; }
        if (state_ == State::release) { reset(); return; }
    }

    void recalcRates() {
        const double sr = sampleRate_;
        attackRate_  = (parameters_.attack  > 0.0f) ? (float)(1.0 / (parameters_.attack  * sr)) : -1.0f;
        decayRate_   = (parameters_.decay   > 0.0f) ? (float)((1.0 - sustainLevel_) / (parameters_.decay * sr)) : -1.0f;
        releaseRate_ = (parameters_.release > 0.0f) ? (float)(sustainLevel_ / (parameters_.release * sr)) : -1.0f;
    }

    double sampleRate_ = 44100.0;
    Parameters parameters_{};
    State state_ = State::idle;
    float envelopeVal_ = 0.0f;
    float sustainLevel_ = 1.0f;
    float attackRate_ = -1.0f, decayRate_ = -1.0f, releaseRate_ = -1.0f;
};

} // namespace casperaki
