// 2nd-order (biquad) low-pass with a settable cutoff, for the per-lane
// `signalProcessors.lowPassFilter` automation (docs/63: break/buildup filter
// risers, e.g. 1000->30000 Hz sweeps). Stand-in for te::LowPassPlugin — an RBJ
// cookbook low-pass at Q=1/sqrt(2) (Butterworth), recomputed when the automated
// cutoff moves. Stereo (independent state per channel). Like te::LowPassPlugin the
// cutoff is clamped to its 10..22000 Hz parameter range (tracktion_LowPass.cpp:21,
// so the 30000 Hz "open" end of a sweep is 22 kHz) and the filter stays in circuit
// with continuous state — no bypass, so re-closing a sweep never clicks (docs/67 #15).
#pragma once

#include "AudioBuffer.h"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace casperaki {

class LowPass {
public:
    explicit LowPass(double sampleRate = 44100.0) : sr_(sampleRate) {
        if (kMaxHz >= sr_ * 0.5)
            throw std::runtime_error("LowPass: the 22000 Hz legacy maximum needs a sample rate above 44000 Hz");
        setCutoff(30000.0);
    }

    void reset() { for (auto& s : z1_) s = 0; for (auto& s : z2_) s = 0; }

    void setCutoff(double hz) {
        hz = std::min(kMaxHz, std::max(kMinHz, hz));
        if (hz == cur_) return;
        cur_ = hz;
        const double w0 = 2.0 * 3.14159265358979323846 * hz / sr_;
        const double cosw = std::cos(w0), sinw = std::sin(w0);
        const double Q = 0.70710678;                          // Butterworth
        const double alpha = sinw / (2.0 * Q);
        const double b0 = (1.0 - cosw) * 0.5, b1 = 1.0 - cosw, b2 = (1.0 - cosw) * 0.5;
        const double a0 = 1.0 + alpha, a1 = -2.0 * cosw, a2 = 1.0 - alpha;
        b0_ = (float)(b0 / a0); b1_ = (float)(b1 / a0); b2_ = (float)(b2 / a0);
        a1_ = (float)(a1 / a0); a2_ = (float)(a2 / a0);
    }

    // Transposed Direct Form II, one sample, given channel.
    float processSample(int ch, float x) {
        const float y = b0_ * x + z1_[ch];
        z1_[ch] = b1_ * x - a1_ * y + z2_[ch];
        z2_[ch] = b2_ * x - a2_ * y;
        return y;
    }

private:
    static constexpr double kMinHz = 10.0, kMaxHz = 22000.0;
    double sr_;
    double cur_ = -1.0;
    float b0_ = 1, b1_ = 0, b2_ = 0, a1_ = 0, a2_ = 0;
    float z1_[2] = {0, 0}, z2_[2] = {0, 0};
};

} // namespace casperaki
