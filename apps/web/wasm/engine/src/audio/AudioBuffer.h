// Minimal owning float audio buffer — the subset of juce::AudioBuffer<float>
// the sampler/mix path uses (docs/60 Phase 1 sampler half). Channels are stored
// as separate contiguous planes (planar), like juce. Portable C++17: builds
// native (tests) and under Emscripten (worklet).
#pragma once

#include <algorithm>
#include <cstring>
#include <vector>

namespace casperaki {

class AudioBuffer {
public:
    AudioBuffer() = default;
    AudioBuffer(int numChannels, int numSamples) { setSize(numChannels, numSamples); }

    void setSize(int numChannels, int numSamples) {
        numChannels_ = std::max(0, numChannels);
        numSamples_ = std::max(0, numSamples);
        planes_.assign(static_cast<size_t>(numChannels_),
                       std::vector<float>(static_cast<size_t>(numSamples_), 0.0f));
    }

    int getNumChannels() const { return numChannels_; }
    int getNumSamples() const { return numSamples_; }

    void clear() {
        for (auto& p : planes_) std::fill(p.begin(), p.end(), 0.0f);
    }

    float* getWritePointer(int ch) { return planes_[static_cast<size_t>(ch)].data(); }
    float* getWritePointer(int ch, int offset) {
        return planes_[static_cast<size_t>(ch)].data() + offset;
    }
    const float* getReadPointer(int ch) const { return planes_[static_cast<size_t>(ch)].data(); }
    const float* getReadPointer(int ch, int offset) const {
        return planes_[static_cast<size_t>(ch)].data() + offset;
    }

    // Copy `num` samples from src[srcCh] starting at srcOffset into this[destCh].
    void copyFrom(int destCh, int destOffset, const AudioBuffer& src, int srcCh,
                  int srcOffset, int num) {
        if (num <= 0) return;
        std::memcpy(getWritePointer(destCh, destOffset),
                    src.getReadPointer(srcCh, srcOffset),
                    static_cast<size_t>(num) * sizeof(float));
    }

private:
    int numChannels_ = 0;
    int numSamples_ = 0;
    std::vector<std::vector<float>> planes_;
};

} // namespace casperaki
