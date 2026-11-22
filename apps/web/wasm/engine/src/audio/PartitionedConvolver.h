// Two-channel FIR convolution by uniformly partitioned overlap-save FFT convolution, used
// by the matchering stream (audio/Matchering.h) to run the mid filter over the mid signal
// and the side filter over the side signal.
//
// Method (textbook uniformly partitioned overlap-save with a frequency-domain delay line):
//  - Partition size B (a power of two), FFT size 2B. Each filter h of length L is cut
//    into P = ceil(L / B) pieces of B taps; piece p, zero-padded to 2B, is transformed
//    once: H_p.
//  - Each call to processBlock() takes the next B input frames of both channels. The
//    last 2B input frames (previous block, then this block) are transformed: X_j. The
//    output spectrum is Y_j = sum_p H_p * X_{j-p} (X_{j-p} kept in a ring of P spectra).
//    The last B samples of the inverse transform of Y_j are the convolution output for
//    this block's B frames (the first B are circular wrap-around and are discarded).
//  - Both channels share one complex FFT each way: the mid frame goes in the real part
//    and the side frame in the imaginary part. Their spectra are separated by conjugate
//    symmetry, M[k] = (Z[k] + conj Z[-k]) / 2, S[k] = (Z[k] - conj Z[-k]) / 2i, multiplied
//    by their own filters, recombined as Ym + i*Ys (Hermitian halves rebuilt) and
//    inverse-transformed once: the real part is the mid output, the imaginary part the
//    side output.
//
// The result is the plain causal convolution y[t] = sum_k h[k] x[t-k] (x = 0 before the
// first frame), produced one whole block of B frames at a time. A caller that buffers B
// input frames and then calls processBlock() therefore has a fixed latency of B frames,
// and its output does not depend on how the input was chopped into calls.
#pragma once

#include "Fft.h"

#include <algorithm>
#include <cstddef>
#include <stdexcept>
#include <string>
#include <vector>

namespace casperaki {
namespace dsp {

class StereoPartitionedConvolver {
public:
    StereoPartitionedConvolver(const float* firA, const float* firB, int firLength, int partitionSize)
        : b_(partitionSize), n_(2 * partitionSize), fwd_(2 * partitionSize, false), inv_(2 * partitionSize, true) {
        if (partitionSize < 8 || (partitionSize & (partitionSize - 1)) != 0)
            throw std::invalid_argument("StereoPartitionedConvolver: partition size must be a power of two >= 8, got " +
                                        std::to_string(partitionSize));
        if (firLength <= 0) throw std::invalid_argument("StereoPartitionedConvolver: empty filter");
        p_ = (firLength + b_ - 1) / b_;
        bins_ = b_ + 1;
        const size_t spectra = (size_t)p_ * (size_t)bins_;
        haRe_.assign(spectra, 0.0f); haIm_.assign(spectra, 0.0f);
        hbRe_.assign(spectra, 0.0f); hbIm_.assign(spectra, 0.0f);
        xaRe_.assign(spectra, 0.0f); xaIm_.assign(spectra, 0.0f);
        xbRe_.assign(spectra, 0.0f); xbIm_.assign(spectra, 0.0f);
        frame_.assign((size_t)n_, kiss_fft_cpx{0.0f, 0.0f});
        spec_.assign((size_t)n_, kiss_fft_cpx{0.0f, 0.0f});
        out_.assign((size_t)n_, kiss_fft_cpx{0.0f, 0.0f});
        accARe_.assign((size_t)bins_, 0.0f); accAIm_.assign((size_t)bins_, 0.0f);
        accBRe_.assign((size_t)bins_, 0.0f); accBIm_.assign((size_t)bins_, 0.0f);

        // Filter piece spectra, with the inverse transform's 1/(2B) folded in. Both filters
        // are transformed together (A real, B imaginary) and separated like the signals.
        const float scale = 1.0f / (float)n_;
        std::vector<kiss_fft_cpx> piece((size_t)n_);
        for (int p = 0; p < p_; ++p) {
            for (int t = 0; t < n_; ++t) {
                const int k = p * b_ + t;
                const bool inside = t < b_ && k < firLength;
                piece[(size_t)t] = kiss_fft_cpx{inside ? firA[k] : 0.0f, inside ? firB[k] : 0.0f};
            }
            fwd_.run(piece.data(), spec_.data());
            const size_t base = (size_t)p * (size_t)bins_;
            separate(spec_, base, haRe_, haIm_, hbRe_, hbIm_);
            for (int k = 0; k < bins_; ++k) {
                haRe_[base + k] *= scale; haIm_[base + k] *= scale;
                hbRe_[base + k] *= scale; hbIm_[base + k] *= scale;
            }
        }
    }

    int partitionSize() const { return b_; }

    // inA/inB: the next B input frames of each channel; outA/outB: B output frames (the
    // convolution output for those same frames). Inputs and outputs may alias.
    void processBlock(const float* inA, const float* inB, float* outA, float* outB) {
        // Slide the 2B-frame input window: old second half -> first half, new block -> second half.
        for (int t = 0; t < b_; ++t) frame_[(size_t)t] = frame_[(size_t)(t + b_)];
        for (int t = 0; t < b_; ++t) frame_[(size_t)(t + b_)] = kiss_fft_cpx{inA[t], inB[t]};
        fwd_.run(frame_.data(), spec_.data());
        head_ = (head_ == 0 ? p_ : head_) - 1;  // ring slot of the newest input spectrum
        separate(spec_, (size_t)head_ * (size_t)bins_, xaRe_, xaIm_, xbRe_, xbIm_);

        // Y = sum_p H_p * X_{j-p}; X_{j-p} lives in slot (head + p) mod P.
        std::fill(accARe_.begin(), accARe_.end(), 0.0f); std::fill(accAIm_.begin(), accAIm_.end(), 0.0f);
        std::fill(accBRe_.begin(), accBRe_.end(), 0.0f); std::fill(accBIm_.begin(), accBIm_.end(), 0.0f);
        for (int p = 0; p < p_; ++p) {
            int slot = head_ + p;
            if (slot >= p_) slot -= p_;
            const size_t h = (size_t)p * (size_t)bins_, x = (size_t)slot * (size_t)bins_;
            multiplyAdd(&haRe_[h], &haIm_[h], &xaRe_[x], &xaIm_[x], accARe_.data(), accAIm_.data());
            multiplyAdd(&hbRe_[h], &hbIm_[h], &xbRe_[x], &xbIm_[x], accBRe_.data(), accBIm_.data());
        }

        // Rebuild the full spectrum of (yA + i*yB) from the two Hermitian half-spectra:
        // W[k] = YA[k] + i YB[k], W[2B-k] = conj YA[k] + i conj YB[k].
        for (int k = 0; k < bins_; ++k) {
            const float ar = accARe_[(size_t)k], ai = accAIm_[(size_t)k];
            const float br = accBRe_[(size_t)k], bi = accBIm_[(size_t)k];
            spec_[(size_t)k] = kiss_fft_cpx{ar - bi, ai + br};
            if (k > 0 && k < b_) spec_[(size_t)(n_ - k)] = kiss_fft_cpx{ar + bi, br - ai};
        }
        inv_.run(spec_.data(), out_.data());
        const kiss_fft_cpx* y = out_.data();
        for (int t = 0; t < b_; ++t) {
            outA[t] = y[(size_t)(t + b_)].r;
            outB[t] = y[(size_t)(t + b_)].i;
        }
    }

private:
    // Split the spectrum Z of (a + i*b), a and b real, into the half-spectra of a and b
    // (bins 0..B), written at offset base.
    void separate(const std::vector<kiss_fft_cpx>& z, size_t base, std::vector<float>& aRe, std::vector<float>& aIm,
                  std::vector<float>& bRe, std::vector<float>& bIm) const {
        for (int k = 0; k < bins_; ++k) {
            const kiss_fft_cpx zk = z[(size_t)k];
            const kiss_fft_cpx zm = z[(size_t)((n_ - k) & (n_ - 1))];  // Z[-k]
            aRe[base + k] = 0.5f * (zk.r + zm.r);
            aIm[base + k] = 0.5f * (zk.i - zm.i);
            bRe[base + k] = 0.5f * (zk.i + zm.i);
            bIm[base + k] = 0.5f * (zm.r - zk.r);
        }
    }

    void multiplyAdd(const float* __restrict hr, const float* __restrict hi, const float* __restrict xr,
                     const float* __restrict xi, float* __restrict accR, float* __restrict accI) const {
        for (int k = 0; k < bins_; ++k) {
            accR[k] += hr[k] * xr[k] - hi[k] * xi[k];
            accI[k] += hr[k] * xi[k] + hi[k] * xr[k];
        }
    }

    int b_, n_, p_ = 0, bins_ = 0, head_ = 0;
    KissPlan fwd_, inv_;
    std::vector<float> haRe_, haIm_, hbRe_, hbIm_;  // filter piece spectra [P][B+1]
    std::vector<float> xaRe_, xaIm_, xbRe_, xbIm_;  // ring of input spectra [P][B+1]
    std::vector<float> accARe_, accAIm_, accBRe_, accBIm_;
    std::vector<kiss_fft_cpx> frame_, spec_, out_;
};

} // namespace dsp
} // namespace casperaki
