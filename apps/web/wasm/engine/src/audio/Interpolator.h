// Faithful port of juce::LagrangeInterpolator (4-point Lagrange resampler), the
// resampler CasperakiSamplerPlugin's SampledNote uses (resampler[ch].processAdding).
// Transcribed from juce_GenericInterpolator.h (GenericInterpolator<LagrangeTraits,5>)
// + juce_LagrangeInterpolator.cpp (valueAtOffset). ISC-licensed source; this is a
// clean re-implementation of the same algorithm so the WASM voice resamples
// bit-for-bit the way the native engine does.
//
// State: a stateful filter — one instance per channel; reset() on any break in
// the input stream's continuity.
#pragma once

#include <algorithm>

namespace casperaki {

class LagrangeInterpolator {
public:
    static constexpr int kMemorySize = 5;

    LagrangeInterpolator() { reset(); }

    void reset() {
        indexBuffer_ = 0;
        subSamplePos_ = 1.0;
        for (float& v : lastInputSamples_) v = 0.0f;
    }

    // Resample `inputSamples` into `outputSamples`, ADDING gain*result to whatever
    // is already in outputSamples (juce processAdding semantics). Returns the
    // number of input samples consumed.
    int processAdding(double speedRatio, const float* inputSamples, float* outputSamples,
                      int numOutputSamplesToProduce, float gain) {
        int numUsed = 0;
        double pos = subSamplePos_;

        for (int i = 0; i < numOutputSamplesToProduce; ++i) {
            while (pos >= 1.0) {
                pushInterpolationSample(inputSamples[numUsed++]);
                pos -= 1.0;
            }

            outputSamples[i] += gain * valueAtOffset(lastInputSamples_,
                                                     static_cast<float>(pos), indexBuffer_);
            pos += speedRatio;
        }

        subSamplePos_ = pos;
        return numUsed;
    }

    // Advance exactly as processAdding would over `numOutputSamples`, but produce
    // no output (seek: fast-forward a voice that is already sounding). The input
    // ring + sub-sample phase end up bit-identical to having rendered the span.
    // Returns the number of input samples consumed.
    int skip(double speedRatio, const float* inputSamples, int numOutputSamples) {
        int numUsed = 0;
        double pos = subSamplePos_;
        for (int i = 0; i < numOutputSamples; ++i) {
            while (pos >= 1.0) {
                pushInterpolationSample(inputSamples[numUsed++]);
                pos -= 1.0;
            }
            pos += speedRatio;
        }
        subSamplePos_ = pos;
        return numUsed;
    }

private:
    void pushInterpolationSample(float newValue) {
        lastInputSamples_[indexBuffer_] = newValue;
        if (++indexBuffer_ == kMemorySize) indexBuffer_ = 0;
    }

    // juce_LagrangeInterpolator.cpp: 4-point Lagrange. calcCoefficient<k> builds
    // the product of (offset - j)/(k - j) for j != k (sign folded into the
    // -2..+2 spread), summed over the 5-sample ring starting at `index`.
    static float valueAtOffset(const float* inputs, float offset, int index) {
        float result = 0.0f;
        result += calcCoefficient<0>(inputs[index], offset); if (++index == 5) index = 0;
        result += calcCoefficient<1>(inputs[index], offset); if (++index == 5) index = 0;
        result += calcCoefficient<2>(inputs[index], offset); if (++index == 5) index = 0;
        result += calcCoefficient<3>(inputs[index], offset); if (++index == 5) index = 0;
        result += calcCoefficient<4>(inputs[index], offset);
        return result;
    }

    template <int k>
    static float calcCoefficient(float input, float offset) {
        applyHelper<0 - k>(input, -2.0f - offset);
        applyHelper<1 - k>(input, -1.0f - offset);
        applyHelper<2 - k>(input, 0.0f - offset);
        applyHelper<3 - k>(input, 1.0f - offset);
        applyHelper<4 - k>(input, 2.0f - offset);
        return input;
    }

    // LagrangeResampleHelper<0> is a no-op (the j==k term is skipped); all other
    // k scale by b/k. Expressed as a runtime guard so a single template covers both.
    template <int k>
    static void applyHelper(float& a, float b) {
        if (k != 0) a *= b * (1.0f / static_cast<float>(k));
    }

    float lastInputSamples_[kMemorySize];
    double subSamplePos_ = 1.0;
    int indexBuffer_ = 0;
};

} // namespace casperaki
