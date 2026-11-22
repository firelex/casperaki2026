// Port of the legacy JUCE matchering mastering (casperaki_engine/dependencies/matchering/
// Source/Matchering.h + Helpers.h, "M.h" / "H.h" below) to portable C++17, for the two
// code paths masterSongAtemlos(path, out, shouldMaster = true, shouldLimit) runs
// (M.h:1881 -> M.h:1788 performMatcheringProcess):
//   shouldLimit = true  -> JUST_BOOST_AND_LIMIT (M.h:1630): +5 dB, then NC-17 (0, 0.89).
//   shouldLimit = false -> SERGREE (M.h:1617): match levels and the mid/side spectrum to
//                          the reference track "Atemlos", then postProcessNC17 (M.h:1556).
// Only 44.1 kHz is supported, like the original (M.h:1881 "locked to 44.1khz").
//
// Split for live (browser) use:
//  1. analyze(song) looks at the whole unmastered song once and returns a small
//     MasteringProfile: the mid and side FIR filters (4096 taps each) and every gain the
//     original applies afterwards.
//  2. MasteringStream applies a profile block by block, in real time, with any block size.
//     The offline CLI (main_master.cpp) uses exactly these two steps, so the live path is
//     the same computation.
//
// Whole-song facts the apply step needs, and how the profile carries them:
//  - The original convolves in whole 4096-sample blocks starting at 0, and only while
//    blockStart < numFrames - 4096 (M.h:1290 convolveMono). The rest of the song (the
//    final 1..4096 frames) is never written and stays silent before the limiter: every
//    SERGREE master ends in up to 93 ms of (dithered) silence. The profile stores
//    convolvedFrames; the stream zeroes from there on.
//  - Songs shorter than 15 s are first looped up to 15 s (H.h:817
//    checkAndEnsureMinimumLengthInSeconds); the output is that looped 15 s. The caller
//    runs ensureMinimumLength() on the song before analysis and streams the padded song.
//  - The final amplitude coefficient (M.h:1581) depends only on the reference track's
//    peak, a constant (1.0, i.e. no change, for Atemlos). Nothing in the apply step
//    depends on the song's own peak: the original computes the target's normalisation
//    coefficient (M.h:229) but never applies it.
//  - The FIRs are applied by uniformly partitioned overlap-save FFT convolution
//    (audio/PartitionedConvolver.h) in fixed blocks of kConvolutionBlock = 128 frames,
//    counted from frame 0 whatever the caller's block size. So the SERGREE stream has a
//    fixed latency of 128 frames (2.9 ms) and its output is bit-identical for any block
//    size; BOOST has no latency. Output frame t is the master of input frame t - latency.
//
// Faithfulness: the analysis follows the original's float/double operation order. The
// FFT (audio/Fft.h, KISS FFT) and the convolution are independent implementations, so
// the output matches the original up to float rounding (validated against the legacy
// binary: difference far below -90 dBFS RMS, 1/3-octave bands within 0.01 dB).
#pragma once

#include "AudioBuffer.h"
#include "Fft.h"
#include "MatcheringAtemlos.h"
#include "MatcheringNC17.h"
#include "PartitionedConvolver.h"
#include "../../vendor/cpplowess/Lowess.h"

#include <algorithm>
#include <cfloat>
#include <cmath>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace casperaki {
namespace matchering {

inline constexpr double kSampleRate = 44100.0;  // M.h:1881 (sample rate locked)
inline constexpr int kFftSize = 4096;           // M.h:94
inline constexpr double kPieceSeconds = 15.0;   // M.h:1790 ("15.0 is an ideal piece size")
inline constexpr int kMinLengthSeconds = 15;    // M.h:1910-1911
inline constexpr int kConvolutionBlock = 128;   // stream FIR partition = SERGREE latency (frames)
static_assert(kFftSize % kConvolutionBlock == 0, "convolvedFrames (a multiple of 4096) must be whole blocks");

enum class Style { Sergree, BoostAndLimit };

inline Style styleFromName(const std::string& name) {
    if (name == "sergree") return Style::Sergree;
    if (name == "boost") return Style::BoostAndLimit;
    throw std::invalid_argument("matchering: unknown style '" + name + "' (want sergree or boost)");
}

// Everything the apply step needs. Small: two 4096-tap filters plus scalars.
struct MasteringProfile {
    Style style = Style::Sergree;
    int numFrames = 0;        // song length the profile was made for (after the 15 s minimum)
    int convolvedFrames = 0;  // SERGREE: frames >= this are silent before the limiter (M.h:1290)
    std::vector<float> midFir, sideFir;  // SERGREE: 4096 taps each (M.h:1069 getFIRCoefficients)
    float rmsCoefficient = 1.0f;  // SERGREE: applied to the filtered mid/side (M.h:1418 globalRMSCoefficient)
    float preLimiterGain = 1.0f;  // SERGREE: -2 dB (M.h:1561); BOOST: +5 dB (M.h:1636)
    float limiterLouder = 0.0f;   // Casperaki_NC17::setParams(newA, newB) arguments (M.h:1576 / 1637)
    float limiterOutput = 0.89f;
    float finalGain = 1.0f;       // SERGREE: finalAmplitudeCoefficient (M.h:1581); BOOST: not applied
    uint32_t ditherSeedL = 0, ditherSeedR = 0;  // NC-17's rand()-drawn dither seeds
    // Diagnostics (not used by the stream).
    float targetMatchRms = 0.0f, referenceMatchRms = 0.0f;
    int numMidPieces = 0, numSidePieces = 0;
};

// ---------------------------------------------------------------------------------------
// Small numeric helpers.

// Root mean square of a float signal; the squares (float) are summed in double.
inline float rmsLevel(const float* data, int numSamples) {
    if (numSamples <= 0) return 0.0f;
    double sum = 0.0;
    for (int i = 0; i < numSamples; ++i) {
        const float sample = data[i];
        sum += sample * sample;
    }
    return static_cast<float>(std::sqrt(sum / numSamples));
}

// 10^(dB/20) in double (0 at or below -100 dB), rounded to float.
inline float decibelsToGainAsFloat(double decibels) {
    return (float)(decibels > -100.0 ? std::pow(10.0, decibels * 0.05) : 0.0);
}

// H.h:817 checkAndEnsureMinimumLengthInSeconds: loop the audio up to numSeconds.
inline void ensureMinimumLength(AudioBuffer& buffer, double sampleRate, int numSeconds) {
    const int desiredLengthSamples = static_cast<int>(numSeconds * sampleRate);
    if (buffer.getNumSamples() >= desiredLengthSamples) return;
    if (buffer.getNumSamples() == 0) throw std::invalid_argument("ensureMinimumLength: empty song");
    AudioBuffer newBuffer(buffer.getNumChannels(), desiredLengthSamples);
    int writePos = 0;
    while (writePos < desiredLengthSamples) {
        const int samplesToCopy = std::min(buffer.getNumSamples(), desiredLengthSamples - writePos);
        for (int channel = 0; channel < buffer.getNumChannels(); ++channel)
            newBuffer.copyFrom(channel, writePos, buffer, channel, 0, samplesToCopy);
        writePos += samplesToCopy;
    }
    buffer = newBuffer;
}

namespace detail {

using Piece = std::vector<float>;  // a mono segment

// H.h:271 normalizeAudioBuffer(array, normalize_clipped = false): the coefficient only.
inline float normalizationCoefficient(float maxValue) {
    const float threshold = ((float)(std::pow(2, 15) - 61) / (float)std::pow(2, 15));
    const float epsilon = 0.000001;
    float coefficient = 1.0f;
    if (maxValue < threshold) coefficient = std::max(epsilon, maxValue / threshold);
    return coefficient;
}

// M.h:136 calculateMidAndSide.
inline void midAndSide(const AudioBuffer& song, std::vector<float>& mid, std::vector<float>& side) {
    const int n = song.getNumSamples();
    const float* l = song.getReadPointer(0);
    const float* r = song.getReadPointer(1);
    mid.resize((size_t)n);
    side.resize((size_t)n);
    for (int s = 0; s < n; ++s) {
        mid[(size_t)s] = (l[s] + r[s]) * 0.5f;
        side[(size_t)s] = (l[s] - r[s]) * 0.5f;
    }
}

// M.h:324 getRMSES (mono: n_channels = 1).
inline std::vector<float> getRmses(const std::vector<float>& buffer, int pieceSize) {
    const int nFrames = (int)buffer.size() / pieceSize;
    std::vector<float> rmses((size_t)nFrames);
    for (int i = 0; i < nFrames; ++i) {
        float sumSquares = 0;
        const float* p = buffer.data() + (size_t)i * (size_t)pieceSize;
        for (int j = 0; j < pieceSize; ++j) sumSquares += p[j] * p[j];
        rmses[(size_t)i] = std::sqrt(sumSquares / (float)(pieceSize * 1)) / 2.0;  // "/ 2.0" is in the original
    }
    return rmses;
}

// M.h:382 getAverageSquared(array).
inline float getAverageSquared(const std::vector<float>& array) {
    float sum = 0;
    for (size_t i = 0; i < array.size(); ++i) sum += array[i] * array[i];
    const float average = sum / (float)array.size();
    return std::sqrt(average);
}

// M.h:1491 rms.
inline float rms(const std::vector<float>& array) {
    float sumSquared = 0;
    for (const auto& element : array) sumSquared += element * element;
    return std::sqrt(sumSquared / array.size());
}

// M.h:1459 getLPIsAndMatchRMS (match RMS only).
inline float matchRmsOfLoudest(const std::vector<float>& rmses, float averageRms) {
    std::vector<float> loudest;
    for (size_t i = 0; i < rmses.size(); ++i)
        if (rmses[i] >= averageRms) loudest.push_back(rmses[i]);
    return rms(loudest);
}

// M.h:404 analyzeLevelsForMatchRMS (only the mid channel is measured).
inline float analyzeLevelsForMatchRms(const std::vector<float>& mid) {
    const int numSamples = (int)mid.size();
    const int numDivisions = (int)(numSamples / (kPieceSeconds * kSampleRate)) + 1;
    const int pieceSizeInSamples = numSamples / numDivisions;
    const std::vector<float> rmses = getRmses(mid, pieceSizeInSamples);
    const float averageRms = getAverageSquared(rmses);
    return matchRmsOfLoudest(rmses, averageRms);
}

// H.h:510 getLoudestSegmentsAboveAverageRMS (mono). Faithful detail: the fallback
// "loudest segment" buffer is cleared at the start of every iteration (H.h:525), so if no
// segment reaches the average it is the last segment when that one was the loudest so
// far, and silence otherwise.
inline std::vector<Piece> loudestSegmentsAboveAverageRms(const std::vector<float>& buffer, int segmentLength) {
    std::vector<Piece> loudestSegments;
    Piece loudestSegment;
    float loudestSegmentRms = 0.0f;
    float totalRms = 0.0f;
    totalRms += rmsLevel(buffer.data(), (int)buffer.size());
    const float averageRms = totalRms / 1;
    const int n = (int)buffer.size();
    for (int i = 0; i <= n - segmentLength; i += segmentLength) {
        Piece currentSegment(buffer.begin() + i, buffer.begin() + i + segmentLength);
        loudestSegment.assign((size_t)segmentLength, 0.0f);
        float segmentRms = 0.0f;
        segmentRms += rmsLevel(currentSegment.data(), segmentLength);
        if (segmentRms >= averageRms) loudestSegments.push_back(currentSegment);
        if (segmentRms > loudestSegmentRms) {
            loudestSegment = currentSegment;
            loudestSegmentRms = segmentRms;
        }
    }
    if (loudestSegments.empty()) loudestSegments.push_back(loudestSegment);
    return loudestSegments;
}

// M.h:1193 averageFFT(vector of pieces) with M.h:423 windowFFT (the original's window
// there is rectangular, i.e. all ones, so no windowing is applied).
// Returns 4096 (magnitude, phase) pairs, interleaved.
inline std::vector<float> averageFft(const std::vector<Piece>& pieces, dsp::RealFft& fft) {
    const int fftSize = kFftSize, blockSize = kFftSize;
    std::vector<float> sumMag((size_t)fftSize, 0.0f), sumPhase((size_t)fftSize, 0.0f);
    std::vector<float> coefficientBuffer((size_t)fftSize * 2);
    int numberOfWindows = 0;
    for (const auto& piece : pieces) {
        for (int windowIndex = 0; windowIndex < (int)piece.size() - blockSize; windowIndex += blockSize) {
            std::fill(coefficientBuffer.begin(), coefficientBuffer.end(), 0.0f);
            std::copy(piece.begin() + windowIndex, piece.begin() + windowIndex + blockSize, coefficientBuffer.begin());
            fft.forward(coefficientBuffer.data());
            for (int k = 0; k < fftSize; ++k) {
                const float real = coefficientBuffer[(size_t)k * 2];
                const float imag = coefficientBuffer[(size_t)k * 2 + 1];
                sumMag[(size_t)k] += std::sqrt(real * real + imag * imag);
                sumPhase[(size_t)k] += std::atan2(imag, real);
            }
            numberOfWindows++;
        }
    }
    if (numberOfWindows == 0) throw std::logic_error("matchering: no 4096-sample analysis window in the loudest pieces");
    std::vector<float> magAndPhase;
    magAndPhase.reserve((size_t)fftSize * 2);
    for (int i = 0; i < fftSize; ++i) {
        magAndPhase.push_back(sumMag[(size_t)i] / static_cast<float>(numberOfWindows));
        magAndPhase.push_back(sumPhase[(size_t)i] / static_cast<float>(numberOfWindows));
    }
    return magAndPhase;
}

// M.h:707 generateLinSpace.
inline std::vector<float> generateLinSpace(float start, float end, int numPoints) {
    std::vector<float> linspace;
    const float delta = (end - start) / (numPoints - 1);
    for (int i = 0; i < numPoints; ++i) linspace.push_back(start + i * delta);
    return linspace;
}

// M.h:719 generateLogSpace.
inline std::vector<float> generateLogSpace(float min, float max, int numPoints) {
    std::vector<float> logspace;
    const float logMin = std::log10(min);
    const float logMax = std::log10(max);
    const float delta = (logMax - logMin) / (numPoints - 1);
    for (int i = 0; i < numPoints; ++i) logspace.push_back(std::pow(10.0f, logMin + i * delta));
    return logspace;
}

// M.h:999 findNearestNeighbourIndex: the largest x strictly below value (by distance).
inline int findNearestNeighbourIndex(float value, const std::vector<float>& x) {
    float dist = FLT_MAX;
    int idx = -1;
    for (int i = 0; i < (int)x.size(); ++i) {
        const float newDist = value - x[(size_t)i];
        if (newDist > 0 && newDist < dist) {
            dist = newDist;
            idx = i;
        }
    }
    return idx;
}

// M.h:946 interp1 (piecewise-linear; 0 where no grid point lies strictly below).
inline std::vector<float> interp1(const std::vector<float>& x, const std::vector<float>& y, const std::vector<float>& xNew) {
    std::vector<float> dx, dy, slope, intercept;
    for (size_t i = 0; i < x.size(); ++i) {
        if (i < x.size() - 1) {
            dx.push_back(x[i + 1] - x[i]);
            dy.push_back(y[i + 1] - y[i]);
            slope.push_back(dy[i] / dx[i]);
            intercept.push_back(y[i] - x[i] * slope[i]);
        } else {
            dx.push_back(dx[i - 1]);
            dy.push_back(dy[i - 1]);
            slope.push_back(slope[i - 1]);
            intercept.push_back(intercept[i - 1]);
        }
    }
    std::vector<float> yNew;
    yNew.reserve(xNew.size());
    for (size_t i = 0; i < xNew.size(); ++i) {
        const int idx = findNearestNeighbourIndex(xNew[i], x);
        float thisMagnitude;
        if (idx == -1) thisMagnitude = 0;
        else thisMagnitude = slope[(size_t)idx] * xNew[i] + intercept[(size_t)idx];
        yNew.push_back(thisMagnitude);
    }
    return yNew;
}

// M.h:1012 smoothArray (frac 0.0375, nsteps 1, delta 0.01, 44.1 kHz, oversampling 4).
inline std::vector<float> smoothArray(std::vector<float>& matchingFft) {
    const float frac = 0.0375f;
    const int nsteps = 1;
    const float sample_rate = 44100.0f;
    const float delta = 0.01f;
    const float oversampling = 4.0f;
    std::vector<float> linearGrid = generateLinSpace(0.0, sample_rate / 2, kFftSize / 2 + 1);
    const double min_log_freq = linearGrid[1];
    const int num_log_points = (kFftSize / 2) * oversampling + 1;
    std::vector<float> logarithmicGrid = generateLogSpace(min_log_freq, sample_rate / 2, num_log_points);
    std::vector<float> matching_fft_log = interp1(linearGrid, matchingFft, logarithmicGrid);
    std::vector<float> weights(matching_fft_log.size());
    std::vector<float> residWeights(matching_fft_log.size());
    CppLowess::TemplatedLowess<std::vector<float>, float> lowess;
    std::vector<float> newMatchingFftLog(matching_fft_log.size());
    lowess.lowess(logarithmicGrid, matching_fft_log, frac, nsteps, delta, newMatchingFftLog, residWeights, weights);
    return interp1(logarithmicGrid, newMatchingFftLog, linearGrid);
}

// M.h:1069 getFIRCoefficients (+ M.h:465 constrainMin, M.h:473
// magnitude_phase_to_real_imag, M.h:518 ifftshift). Returns the 4096-tap FIR.
inline std::vector<float> firCoefficients(const std::vector<Piece>& targetPieces, const float* referenceAverageFft,
                                          dsp::RealFft& fft) {
    const int fftSize = kFftSize;
    std::vector<float> target = averageFft(targetPieces, fft);
    const float minValue = 0.000001;
    for (int i = 0; i < (int)target.size() / 2; ++i) target[(size_t)i * 2] = std::max(minValue, target[(size_t)i * 2]);

    std::vector<float> fftWindow;
    for (int sample = 0; sample < fftSize; ++sample)
        fftWindow.push_back(0.5f - 0.5f * cosf(2.0f * M_PI * (float)sample / (float)(fftSize)));

    std::vector<float> matchingFftMagsAndPhases, magnitudes;
    for (int sample = 0; sample < fftSize; ++sample) {
        matchingFftMagsAndPhases.push_back((double)referenceAverageFft[sample * 2] / (double)target[(size_t)sample * 2]);
        magnitudes.push_back(matchingFftMagsAndPhases.back());
        matchingFftMagsAndPhases.push_back((double)referenceAverageFft[sample * 2 + 1] - (double)target[(size_t)sample * 2 + 1]);
    }

    const std::vector<float> smoothedMagnitudes = smoothArray(magnitudes);
    for (int i = 0; i < fftSize / 2; ++i) matchingFftMagsAndPhases[(size_t)i * 2] = smoothedMagnitudes[(size_t)i];

    std::vector<float> realAndImag;
    realAndImag.reserve(matchingFftMagsAndPhases.size());
    for (size_t i = 0; i < matchingFftMagsAndPhases.size(); i += 2) {
        const float magnitude = matchingFftMagsAndPhases[i];
        const float phase = matchingFftMagsAndPhases[i + 1];
        realAndImag.push_back(magnitude * cosf(phase));
        realAndImag.push_back(magnitude * sinf(phase));
    }

    fft.inverse(realAndImag.data());

    // ifftshift(vector): n = 8192, shift = 2048, y(4096): y[2048..) = x[0..2048), y[0..2048) = x[2048..4096).
    const int n = (int)realAndImag.size();
    const int shift = n / 4;
    std::vector<float> shifted((size_t)n / 2);
    std::copy(realAndImag.begin(), realAndImag.begin() + shift, shifted.begin() + shift);
    std::copy(realAndImag.begin() + shift, realAndImag.begin() + shift * 2, shifted.begin());
    for (int sample = 0; sample < fftSize; ++sample) shifted[(size_t)sample] *= fftWindow[(size_t)sample];
    return shifted;
}

} // namespace detail

// Step 1: whole-song analysis. `song` must be stereo at 44.1 kHz and at least 15 s long
// (run ensureMinimumLength first, as masterSongAtemlos does).
inline MasteringProfile analyze(const AudioBuffer& song, double sampleRate, Style style) {
    if (sampleRate != kSampleRate)
        throw std::invalid_argument("matchering: only 44100 Hz is supported (the original is locked to it), got " +
                                    std::to_string(sampleRate));
    if (song.getNumChannels() != 2)
        throw std::invalid_argument("matchering: the song must be stereo, got " + std::to_string(song.getNumChannels()) +
                                    " channel(s)");
    const int minFrames = static_cast<int>(kMinLengthSeconds * kSampleRate);
    if (song.getNumSamples() < minFrames)
        throw std::invalid_argument("matchering: song shorter than 15 s; call ensureMinimumLength first");

    MasteringProfile p;
    p.style = style;
    p.numFrames = song.getNumSamples();
    p.limiterLouder = 0.0f;   // M.h:1576 / M.h:1637 limiter.setParams (0.0, 0.89)
    p.limiterOutput = 0.89f;
    const auto seeds = CasperakiNC17::ditherSeedsOfFreshProcess();
    p.ditherSeedL = seeds.first;
    p.ditherSeedR = seeds.second;

    if (style == Style::BoostAndLimit) {
        p.preLimiterGain = decibelsToGainAsFloat(5.0);  // M.h:1636
        p.finalGain = 1.0f;                             // not applied in this style
        return p;
    }

    // --- SERGREE stage 1: matchLevels (M.h:223) ---
    // finalAmplitudeCoefficient = normalizeAudioBuffer(reference, false) (M.h:227).
    p.finalGain = detail::normalizationCoefficient(atemlos::kReferencePeak);
    std::vector<float> mid, side;
    detail::midAndSide(song, mid, side);
    p.targetMatchRms = detail::analyzeLevelsForMatchRms(mid);  // M.h:254
    p.referenceMatchRms = atemlos::kRmsValue;                   // M.h:257
    p.rmsCoefficient = p.referenceMatchRms / p.targetMatchRms;  // M.h:259
    const int segmentLengthInSamples = kSampleRate * kPieceSeconds;  // M.h:120
    std::vector<detail::Piece> midPieces = detail::loudestSegmentsAboveAverageRms(mid, segmentLengthInSamples);
    std::vector<detail::Piece> sidePieces = detail::loudestSegmentsAboveAverageRms(side, segmentLengthInSamples);
    for (auto& piece : midPieces) for (auto& s : piece) s *= p.rmsCoefficient;   // M.h:296 applyGain
    for (auto& piece : sidePieces) for (auto& s : piece) s *= p.rmsCoefficient;
    p.numMidPieces = (int)midPieces.size();
    p.numSidePieces = (int)sidePieces.size();

    // --- SERGREE stage 2: matchFrequencies (M.h:1350), the filter design part ---
    dsp::RealFft fft(12);  // M.h:116 fft (log2 (fftSize))
    p.midFir = detail::firCoefficients(midPieces, atemlos::kMidAverageFft, fft);
    p.sideFir = detail::firCoefficients(sidePieces, atemlos::kSideAverageFft, fft);

    // M.h:1290 convolveMono covers blocks with start < numFrames - 4096.
    int covered = 0;
    for (int windowIndex = 0; windowIndex < p.numFrames - kFftSize; windowIndex += kFftSize) covered = windowIndex + kFftSize;
    p.convolvedFrames = covered;

    // Stage 3 gains (M.h:1556 postProcessNC17).
    p.preLimiterGain = decibelsToGainAsFloat(-2.0);  // M.h:1561
    return p;
}

// Step 2: apply a profile, block by block. Feed the song from frame 0 in order; after
// the last frame, feed latencyFrames() frames of silence to flush. Output frame t is the
// master of input frame t - latencyFrames(); outputs for t < latencyFrames() and for
// input frames past the profile's numFrames are 0 (and do not advance the limiter).
class MasteringStream {
public:
    explicit MasteringStream(const MasteringProfile& profile)
        : p_(profile), limiter_(profile.ditherSeedL, profile.ditherSeedR) {
        if (p_.numFrames <= 0) throw std::invalid_argument("MasteringStream: profile has no frames");
        limiter_.setParams(p_.limiterLouder, p_.limiterOutput);
        limiter_.prepareToPlay(kSampleRate);
        if (p_.style == Style::Sergree) {
            if ((int)p_.midFir.size() != kFftSize || (int)p_.sideFir.size() != kFftSize)
                throw std::invalid_argument("MasteringStream: SERGREE profile needs two 4096-tap filters");
            conv_ = std::make_unique<dsp::StereoPartitionedConvolver>(p_.midFir.data(), p_.sideFir.data(), kFftSize,
                                                                     kConvolutionBlock);
            inMid_.assign(kConvolutionBlock, 0.0f);
            inSide_.assign(kConvolutionBlock, 0.0f);
            readyMid_.assign(kConvolutionBlock, 0.0f);
            readySide_.assign(kConvolutionBlock, 0.0f);
        }
    }

    int latencyFrames() const { return p_.style == Style::Sergree ? kConvolutionBlock : 0; }

    void process(const float* inL, const float* inR, float* outL, float* outR, int numFrames) {
        if (numFrames < 0) throw std::invalid_argument("MasteringStream: negative frame count");
        if (p_.style == Style::BoostAndLimit) processBoost(inL, inR, outL, outR, numFrames);
        else processSergree(inL, inR, outL, outR, numFrames);
    }

private:
    // M.h:1630 JUST_BOOST_AND_LIMIT: result = target; applyGain(+5 dB); NC-17.
    void processBoost(const float* inL, const float* inR, float* outL, float* outR, int numFrames) {
        int valid = 0;
        for (int i = 0; i < numFrames; ++i) {
            if (inputPos_ + i < (int64_t)p_.numFrames) {
                outL[i] = inL[i] * p_.preLimiterGain;
                outR[i] = inR[i] * p_.preLimiterGain;
                ++valid;
            } else {
                outL[i] = 0.0f;
                outR[i] = 0.0f;
            }
        }
        float* io[2] = {outL, outR};
        limiter_.process(io, io, valid);  // valid frames are the leading run of this block
        inputPos_ += numFrames;
    }

    void processSergree(const float* inL, const float* inR, float* outL, float* outR, int numFrames) {
        int runStart = -1, runLen = 0;
        for (int i = 0; i < numFrames; ++i) {
            // M.h:136 calculateMidAndSide.
            inMid_[(size_t)pos_] = (inL[i] + inR[i]) * 0.5f;
            inSide_[(size_t)pos_] = (inL[i] - inR[i]) * 0.5f;
            const int64_t delayed = inputPos_ - kConvolutionBlock;  // input frame this output belongs to
            if (delayed >= 0 && delayed < (int64_t)p_.numFrames) {
                // M.h:1418 *= globalRMSCoefficient, M.h:153 calculateLR, M.h:1561 applyGain(-2 dB).
                const float m = readyMid_[(size_t)pos_] * p_.rmsCoefficient;
                const float s = readySide_[(size_t)pos_] * p_.rmsCoefficient;
                outL[i] = (m + s) * p_.preLimiterGain;
                outR[i] = (m - s) * p_.preLimiterGain;
                if (runStart < 0) runStart = i;
                ++runLen;
            } else {
                outL[i] = 0.0f;
                outR[i] = 0.0f;
            }
            ++inputPos_;
            if (++pos_ == kConvolutionBlock) {
                pos_ = 0;
                const int64_t blockStart = inputPos_ - kConvolutionBlock;
                if (blockStart < (int64_t)p_.convolvedFrames) {
                    // M.h:1290 convolveMono: the causal FIR output for these frames.
                    conv_->processBlock(inMid_.data(), inSide_.data(), readyMid_.data(), readySide_.data());
                } else {
                    // Frames from convolvedFrames on are never convolved in the original: silent.
                    std::fill(readyMid_.begin(), readyMid_.end(), 0.0f);
                    std::fill(readySide_.begin(), readySide_.end(), 0.0f);
                }
            }
        }
        if (runLen > 0) {
            // M.h:1576 NC-17 over the result, then M.h:1581 applyGain(finalAmplitudeCoefficient).
            float* io[2] = {outL + runStart, outR + runStart};
            limiter_.process(io, io, runLen);
            for (int i = runStart; i < runStart + runLen; ++i) {
                outL[i] *= p_.finalGain;
                outR[i] *= p_.finalGain;
            }
        }
    }

    MasteringProfile p_;
    CasperakiNC17 limiter_;
    std::unique_ptr<dsp::StereoPartitionedConvolver> conv_;
    std::vector<float> inMid_, inSide_, readyMid_, readySide_;
    int pos_ = 0;
    int64_t inputPos_ = 0;
};

} // namespace matchering
} // namespace casperaki
