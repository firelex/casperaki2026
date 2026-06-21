// 2nd-order (biquad) low-pass with a settable cutoff, for the per-lane
// `signalProcessors.lowPassFilter` automation (docs/63: break/buildup filter
// risers, e.g. 1000->30000 Hz sweeps). Stand-in for te::LowPassPlugin — an RBJ
// cookbook low-pass at Q=1/sqrt(2) (Butterworth), recomputed when the automated
// cutoff moves. Stereo (independent state per channel). At/above ~Nyquist the
// filter is effectively bypassed (the 30000 Hz "open" end of every sweep).
#pragma once

#include "AudioBuffer.h"
#include <cmath>

namespace casperaki {

class LowPass {
public:
    explicit LowPass(double sampleRate = 44100.0) : sr_(sampleRate) { setCutoff(30000.0); }

    void reset() { for (auto& s : z1_) s = 0; for (auto& s : z2_) s = 0; }

    void setCutoff(double hz) {
        if (hz >= sr_ * 0.49) { bypass_ = true; return; }   // open -> pass-through
        bypass_ = false;
        if (hz < 20.0) hz = 20.0;
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
        if (bypass_) return x;
        const float y = b0_ * x + z1_[ch];
        z1_[ch] = b1_ * x - a1_ * y + z2_[ch];
        z2_[ch] = b2_ * x - a2_ * y;
        return y;
    }

private:
    double sr_;
    bool bypass_ = true;
    float b0_ = 1, b1_ = 0, b2_ = 0, a1_ = 0, a2_ = 0;
    float z1_[2] = {0, 0}, z2_[2] = {0, 0};
};

} // namespace casperaki
