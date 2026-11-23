#pragma once
// Offline mastering of a whole song (the export: the browser's masterSong and the
// server's casperaki_master). On top of the matched master (Matchering.h):
//
// 1. Delay: the output is aligned with the input (block latency + the EQ filters'
//    kFftSize / 2 frames).
// 2. Bass limiting, measured (reported, not acted on): how much the NC-17 limiter pulls on
//    bass-heavy 20 ms blocks (95th percentile). CASPERAKI_MASTER_DEBUG=1 also prints what the
//    limiter adds beyond a level change. On five songs (2026-11-23) neither singled out the
//    one heard as distorted, so no guard acts on them yet.
// 3. True peak: peaks between samples (what a DAC or an MP3 decoder rebuilds) are held at
//    kTruePeakCeilingDb (4x oversampling, as ITU-R BS.1770) by a smooth gain envelope.

#include "AudioBuffer.h"
#include "Matchering.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <deque>
#include <stdexcept>
#include <string>
#include <vector>

namespace casperaki {
namespace matchering {

/** A block is bass-heavy when at least this share of its energy is below kBassHz. */
inline constexpr float kBassShare = 0.5f;
inline constexpr float kBassHz = 120.0f;
inline constexpr float kTruePeakCeilingDb = -1.0f;

struct OfflineMaster {
    AudioBuffer out;
    /** How much the limiter pulled on bass-heavy moments (95th percentile, dB) before the guard. */
    float bassLimitDb = 0.0f;
    /** True peak before / after the true-peak stage (dBTP). */
    float truePeakInDb = 0.0f;
    float truePeakOutDb = 0.0f;
};

namespace offline_detail {

inline float dbToGain(float db) { return std::pow(10.0f, db / 20.0f); }
inline float gainToDb(float g) { return 20.0f * std::log10(std::max(g, 1e-12f)); }

/** Run the stream over the whole song, output aligned with the input (frame t = master of frame t). */
inline AudioBuffer render(const AudioBuffer& song, const MasteringProfile& p, bool limiterOn) {
    MasteringStream stream(p, limiterOn);
    const int delay = stream.latencyFrames() + stream.filterDelayFrames();
    const int n = song.getNumSamples();
    const int total = n + delay;
    AudioBuffer out(2, n);
    const int block = 512;
    std::vector<float> oL((size_t)block), oR((size_t)block), iL((size_t)block), iR((size_t)block);
    for (int start = 0; start < total; start += block) {
        const int len = std::min(block, total - start);
        const int fromSong = std::max(0, std::min(len, n - start));
        std::fill(iL.begin(), iL.end(), 0.0f);
        std::fill(iR.begin(), iR.end(), 0.0f);
        if (fromSong > 0) {
            std::copy(song.getReadPointer(0, start), song.getReadPointer(0, start) + fromSong, iL.begin());
            std::copy(song.getReadPointer(1, start), song.getReadPointer(1, start) + fromSong, iR.begin());
        }
        stream.process(iL.data(), iR.data(), oL.data(), oR.data(), len);
        for (int i = 0; i < len; ++i) {
            const int t = start + i - delay;
            if (t >= 0 && t < n) {
                out.getWritePointer(0)[t] = oL[(size_t)i];
                out.getWritePointer(1)[t] = oR[(size_t)i];
            }
        }
    }
    return out;
}

inline float percentile(std::vector<float> v, float q) {
    if (v.empty()) throw std::logic_error("percentile of nothing");
    std::sort(v.begin(), v.end());
    const size_t i = (size_t)std::min<double>(v.size() - 1, std::floor(q * (double)(v.size() - 1) + 0.5));
    return v[i];
}

/** How hard the limiter pulls on bass-heavy 20 ms blocks (95th percentile, dB); 0 when there are
 *  too few bass-heavy blocks to tell. `pre` = the chain without the limiter, `post` = with it. */
inline float bassLimitDb(const AudioBuffer& pre, const AudioBuffer& post, double sampleRate) {
    const int n = pre.getNumSamples();
    const int blk = (int)std::lround(sampleRate * 0.02);
    const float a = (float)std::exp(-2.0 * M_PI * kBassHz / sampleRate);  // one-pole lowpass, twice
    float lp1 = 0.0f, lp2 = 0.0f;
    std::vector<float> gains, bassGains;
    std::vector<float> blockGain;
    std::vector<bool> blockBass;
    for (int b0 = 0; b0 + blk <= n; b0 += blk) {
        double ePre = 0, ePost = 0, eLow = 0;
        for (int i = b0; i < b0 + blk; ++i) {
            const float l = pre.getReadPointer(0)[i], r = pre.getReadPointer(1)[i];
            const float lo = post.getReadPointer(0)[i], ro = post.getReadPointer(1)[i];
            ePre += (double)l * l + (double)r * r;
            ePost += (double)lo * lo + (double)ro * ro;
            const float mono = 0.5f * (l + r);
            lp1 = (1.0f - a) * mono + a * lp1;
            lp2 = (1.0f - a) * lp1 + a * lp2;
            eLow += 2.0 * (double)lp2 * lp2;
        }
        if (ePre < (double)blk * 2e-6) continue;  // quieter than about -57 dBFS: no limiting to measure
        const float g = (float)(10.0 * std::log10(ePost / ePre));
        blockGain.push_back(g);
        blockBass.push_back(eLow / ePre >= kBassShare);
    }
    if (blockGain.size() < 50) return 0.0f;
    // The limiter's own static gain: what the least limited blocks get.
    const float staticGain = percentile(blockGain, 0.95f);
    std::vector<float> bassReduction;
    for (size_t i = 0; i < blockGain.size(); ++i)
        if (blockBass[i]) bassReduction.push_back(staticGain - blockGain[i]);
    if (std::getenv("CASPERAKI_MASTER_DEBUG")) {
        // What the limiter adds beyond a level change: per block, the output minus the input
        // scaled by the block's own best-fit gain, relative to the output (dB; lower = cleaner).
        std::vector<float> addBass, addAll;
        for (int b0 = 0; b0 + blk <= n; b0 += blk) {
            double ePre = 0, cross = 0, ePost = 0, eLow = 0;
            float q1 = 0, q2 = 0;
            for (int i = b0; i < b0 + blk; ++i)
                for (int ch = 0; ch < 2; ++ch) {
                    const double x = pre.getReadPointer(ch)[i], y = post.getReadPointer(ch)[i];
                    ePre += x * x; cross += x * y; ePost += y * y;
                }
            if (ePre < (double)blk * 2e-6) continue;
            const double k = cross / ePre;
            double eRes = 0;
            for (int i = b0; i < b0 + blk; ++i)
                for (int ch = 0; ch < 2; ++ch) {
                    const double d = post.getReadPointer(ch)[i] - k * pre.getReadPointer(ch)[i];
                    eRes += d * d;
                }
            for (int i = b0; i < b0 + blk; ++i) {
                const float mono = 0.5f * (pre.getReadPointer(0)[i] + pre.getReadPointer(1)[i]);
                q1 = (1.0f - a) * mono + a * q1; q2 = (1.0f - a) * q1 + a * q2; eLow += 2.0 * (double)q2 * q2;
            }
            const float addDb = (float)(10.0 * std::log10(std::max(eRes, 1e-20) / ePost));
            addAll.push_back(addDb);
            if (eLow / ePre >= kBassShare) addBass.push_back(addDb);
        }
        std::fprintf(stderr, "[bass-guard] added by limiter (dB re output): bass p50 %.1f p95 %.1f p99 %.1f | all p50 %.1f p95 %.1f p99 %.1f\n",
                     addBass.empty() ? -99 : percentile(addBass, 0.5f), addBass.empty() ? -99 : percentile(addBass, 0.95f),
                     addBass.empty() ? -99 : percentile(addBass, 0.99f), percentile(addAll, 0.5f), percentile(addAll, 0.95f),
                     percentile(addAll, 0.99f));
        std::vector<float> all;
        for (float g : blockGain) all.push_back(staticGain - g);
        std::fprintf(stderr, "[bass-guard] blocks %zu bass %zu (%.0f%%) | bass GR p50 %.2f p90 %.2f p95 %.2f p99 %.2f | all GR p90 %.2f p99 %.2f\n",
                     blockGain.size(), bassReduction.size(), 100.0 * bassReduction.size() / blockGain.size(),
                     bassReduction.empty() ? 0 : percentile(bassReduction, 0.5f), bassReduction.empty() ? 0 : percentile(bassReduction, 0.9f),
                     bassReduction.empty() ? 0 : percentile(bassReduction, 0.95f), bassReduction.empty() ? 0 : percentile(bassReduction, 0.99f),
                     percentile(all, 0.9f), percentile(all, 0.99f));
    }
    if (bassReduction.size() < 25) return 0.0f;
    return std::max(0.0f, percentile(bassReduction, 0.95f));
}

/** 4x oversampled peaks between samples: for each frame, the largest |x| over it and the three
 *  interpolated points before the next frame (Hann-windowed sinc, 12 taps per phase). */
inline std::vector<float> truePeaksPerFrame(const AudioBuffer& b) {
    constexpr int kTaps = 12, kHalf = kTaps / 2, kOver = 4;
    float coef[kOver][kTaps];
    for (int ph = 0; ph < kOver; ++ph) {
        const double frac = (double)ph / kOver;
        for (int k = 0; k < kTaps; ++k) {
            const double x = (double)(k - kHalf + 1) - frac;  // tap offset from the interpolated point
            const double sinc = std::abs(x) < 1e-9 ? 1.0 : std::sin(M_PI * x) / (M_PI * x);
            const double w = 0.5 + 0.5 * std::cos(M_PI * x / (kHalf + 0.5));
            coef[ph][k] = (float)(sinc * w);
        }
    }
    const int n = b.getNumSamples();
    std::vector<float> peak((size_t)n, 0.0f);
    for (int ch = 0; ch < 2; ++ch) {
        const float* x = b.getReadPointer(ch);
        for (int t = 0; t < n; ++t) {
            float m = std::abs(x[t]);
            for (int ph = 1; ph < kOver; ++ph) {
                float acc = 0.0f;
                for (int k = 0; k < kTaps; ++k) {
                    const int idx = t + k - kHalf + 1;
                    if (idx >= 0 && idx < n) acc += coef[ph][k] * x[idx];
                }
                m = std::max(m, std::abs(acc));
            }
            peak[(size_t)t] = std::max(peak[(size_t)t], m);
        }
    }
    return peak;
}

inline float truePeakDb(const AudioBuffer& b) {
    const std::vector<float> p = truePeaksPerFrame(b);
    return gainToDb(*std::max_element(p.begin(), p.end()));
}

/** Hold the true peak at `ceilingDb`: the gain each frame needs, spread over a 1.5 ms look-ahead
 *  (reached smoothly before the peak) and released over 60 ms. Returns the true peak after. */
inline float limitTruePeak(AudioBuffer& b, float ceilingDb, double sampleRate) {
    const int n = b.getNumSamples();
    float ceiling = dbToGain(ceilingDb);
    for (int pass = 0; pass < 4; ++pass) {
        const std::vector<float> peak = truePeaksPerFrame(b);
        const float before = *std::max_element(peak.begin(), peak.end());
        if (before <= dbToGain(ceilingDb) * 1.0005f) return gainToDb(before);
        const int look = (int)std::lround(sampleRate * 0.0015);
        // Needed gain per frame, then the minimum over [t - look, t + look] (sliding window).
        std::vector<float> need((size_t)n), g((size_t)n);
        for (int t = 0; t < n; ++t) need[(size_t)t] = peak[(size_t)t] > ceiling ? ceiling / peak[(size_t)t] : 1.0f;
        std::deque<int> q;
        for (int t = 0, j = 0; t < n; ++t) {
            while (j < n && j <= t + look) {
                while (!q.empty() && need[(size_t)q.back()] >= need[(size_t)j]) q.pop_back();
                q.push_back(j++);
            }
            while (q.front() < t - look) q.pop_front();
            g[(size_t)t] = need[(size_t)q.front()];
        }
        // Smooth: a backward pass ramps down into each reduction, a forward pass releases slowly.
        const float att = (float)std::exp(-1.0 / (sampleRate * 0.0005));
        const float rel = (float)std::exp(-1.0 / (sampleRate * 0.060));
        for (int t = n - 2; t >= 0; --t) g[(size_t)t] = std::min(g[(size_t)t], att * g[(size_t)t + 1] + (1.0f - att));
        for (int t = 1; t < n; ++t) g[(size_t)t] = std::min(g[(size_t)t], rel * g[(size_t)t - 1] + (1.0f - rel));
        for (int ch = 0; ch < 2; ++ch) {
            float* x = b.getWritePointer(ch);
            for (int t = 0; t < n; ++t) x[t] *= g[(size_t)t];
        }
        ceiling *= 0.995f;  // a remaining overshoot (interpolation of the new envelope): aim a little lower
    }
    const float after = truePeakDb(b);
    if (after > ceilingDb + 0.05f)
        throw std::runtime_error("true-peak limiter: still " + std::to_string(after) + " dBTP after 4 passes");
    return after;
}

} // namespace offline_detail

/** Master a whole (padded, see ensureMinimumLength) song with an analysed profile: aligned and
 *  true-peak limited (bass limiting measured). */
inline OfflineMaster masterOffline(const AudioBuffer& song, const MasteringProfile& profile) {
    using namespace offline_detail;
    OfflineMaster r;
    const AudioBuffer pre = render(song, profile, false);
    r.out = render(song, profile, true);
    // Measured and reported only: on real songs the limiter's work on bass moments did not single
    // out the song heard as distorted (2026-11-23), so no song is changed by it yet.
    r.bassLimitDb = bassLimitDb(pre, r.out, kSampleRate);
    r.truePeakInDb = truePeakDb(r.out);
    r.truePeakOutDb = limitTruePeak(r.out, kTruePeakCeilingDb, kSampleRate);
    return r;
}

} // namespace matchering
} // namespace casperaki
