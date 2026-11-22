// Real-input FFT helpers for the matchering analysis (audio/Matchering.h), built on the
// vendored KISS FFT (vendor/kissfft, BSD-3-Clause) with KISS FFT's own twiddle tables.
//
// Conventions (the analysis code relies on them):
//  forward(d): d holds 2*N floats. Reads d[0..N) as a real signal x and writes its full
//              N-bin DFT X[k] = sum_t x[t] e^{-2 pi i k t / N}, interleaved (re, im), into
//              d[0..2N). No scaling.
//  inverse(d): d holds 2*N floats. Reads bins 0..N/2 interleaved (re, im) and returns the
//              real signal whose spectrum is their Hermitian extension, scaled by 1/N:
//                x[t] = (1/N) * Re( sum_k X[k] e^{+2 pi i k t / N} ),  X[N-k] = conj(X[k]).
//              The imaginary parts of bins 0 and N/2 do not affect a real signal and are
//              ignored. Writes x into d[0..N); d[N..2N) is left untouched.
#pragma once

#include "../../vendor/kissfft/kiss_fft.h"

#include <cstdlib>
#include <stdexcept>
#include <string>
#include <vector>

namespace casperaki {
namespace dsp {

// Owns a KISS FFT plan (complex, size n, one direction).
class KissPlan {
public:
    KissPlan(int n, bool inverse) : cfg_(kiss_fft_alloc(n, inverse ? 1 : 0, nullptr, nullptr)) {
        if (cfg_ == nullptr) throw std::runtime_error("KissPlan: kiss_fft_alloc failed for size " + std::to_string(n));
    }
    ~KissPlan() { kiss_fft_free(cfg_); }
    KissPlan(const KissPlan&) = delete;
    KissPlan& operator=(const KissPlan&) = delete;
    // Unscaled complex DFT (sign -1 forward, +1 inverse). in and out must not overlap.
    void run(const kiss_fft_cpx* in, kiss_fft_cpx* out) const { kiss_fft(cfg_, in, out); }

private:
    kiss_fft_cfg cfg_;
};

class RealFft {
public:
    explicit RealFft(int order) : n_(checkedSize(order)), fwd_(n_, false), inv_(n_, true) {
        in_.resize((size_t)n_);
        out_.resize((size_t)n_);
    }

    int size() const { return n_; }

    void forward(float* d) {
        for (int i = 0; i < n_; ++i) in_[(size_t)i] = kiss_fft_cpx{d[i], 0.0f};
        fwd_.run(in_.data(), out_.data());
        for (int k = 0; k < n_; ++k) {
            d[2 * k] = out_[(size_t)k].r;
            d[2 * k + 1] = out_[(size_t)k].i;
        }
    }

    void inverse(float* d) {
        const int half = n_ / 2;
        in_[0] = kiss_fft_cpx{d[0], 0.0f};
        in_[(size_t)half] = kiss_fft_cpx{d[2 * half], 0.0f};
        for (int k = 1; k < half; ++k) {
            in_[(size_t)k] = kiss_fft_cpx{d[2 * k], d[2 * k + 1]};
            in_[(size_t)(n_ - k)] = kiss_fft_cpx{d[2 * k], -d[2 * k + 1]};
        }
        inv_.run(in_.data(), out_.data());
        const float scale = 1.0f / (float)n_;
        for (int t = 0; t < n_; ++t) d[t] = out_[(size_t)t].r * scale;
    }

private:
    static int checkedSize(int order) {
        if (order < 3 || order > 20)
            throw std::invalid_argument("RealFft: order must be in [3, 20], got " + std::to_string(order));
        return 1 << order;
    }

    int n_;
    KissPlan fwd_, inv_;
    std::vector<kiss_fft_cpx> in_, out_;
};

} // namespace dsp
} // namespace casperaki
