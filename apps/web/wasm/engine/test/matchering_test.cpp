// Tests for the matchering port (audio/Matchering.h and its FFT / convolution helpers).
//   matchering_test <atemlos.json> <referenceAtemlos.wav>
// The two paths (from CMakeLists) check the generated MatcheringAtemlos.h against its
// sources. Agreement with the legacy original (to float rounding) is checked end to end
// against its binary (see README "Mastering (matchering port)").
#include "../src/audio/Matchering.h"
#include "../src/audio/MasterOffline.h"
#include "../src/audio/WavFile.h"
#include "../vendor/json.hpp"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <functional>
#include <sstream>
#include <string>
#include <vector>

using namespace casperaki;

static int failures = 0;
#define CHECK(cond, msg)                                                         \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, msg);   \
            ++failures;                                                          \
        }                                                                        \
    } while (0)

static uint32_t lcg = 12345;
static float noise() {
    lcg = lcg * 1664525u + 1013904223u;
    return (float)((double)(lcg >> 8) / 8388608.0 - 1.0);
}

static void testFft() {
    const int order = 12, n = 1 << order;
    dsp::RealFft fft(order);
    std::vector<float> x((size_t)n), d((size_t)n * 2);
    for (auto& v : x) v = noise();
    std::copy(x.begin(), x.end(), d.begin());
    fft.forward(d.data());
    double maxErr = 0, maxMag = 0;
    for (int k : {0, 1, 7, 100, 2047, 2048, 3000, 4095}) {
        double re = 0, im = 0;
        for (int t = 0; t < n; ++t) {
            const double ph = -2.0 * M_PI * (double)k * t / n;
            re += x[(size_t)t] * std::cos(ph);
            im += x[(size_t)t] * std::sin(ph);
        }
        maxErr = std::max(maxErr, std::hypot(d[(size_t)k * 2] - re, d[(size_t)k * 2 + 1] - im));
        maxMag = std::max(maxMag, std::hypot(re, im));
    }
    CHECK(maxErr < 1e-3 * std::max(1.0, maxMag / 10), "forward FFT disagrees with a direct DFT");
    fft.inverse(d.data());
    double rt = 0;
    for (int i = 0; i < n; ++i) rt = std::max(rt, (double)std::fabs(d[(size_t)i] - x[(size_t)i]));
    CHECK(rt < 1e-5, "inverse(forward(x)) != x");
}

// Partitioned convolution of two channels with two different filters vs direct FIR.
static void testConvolver() {
    for (const int irLen : {4096, 1000}) {
        for (const int block : {128, 512}) {
            const int blocks = 40;
            std::vector<float> irA((size_t)irLen), irB((size_t)irLen), a((size_t)block * blocks), b(a.size());
            std::vector<float> ya(a.size()), yb(a.size());
            for (auto& v : irA) v = noise() * 0.01f;
            for (auto& v : irB) v = noise() * 0.01f;
            for (auto& v : a) v = noise();
            for (auto& v : b) v = noise();
            dsp::StereoPartitionedConvolver conv(irA.data(), irB.data(), irLen, block);
            for (int j = 0; j < blocks; ++j) {
                const size_t o = (size_t)j * (size_t)block;
                conv.processBlock(a.data() + o, b.data() + o, ya.data() + o, yb.data() + o);
            }
            double maxErr = 0;
            for (int t = 0; t < block * blocks; t += 37) {
                double da = 0, db = 0;
                for (int k = 0; k < irLen && k <= t; ++k) {
                    da += (double)irA[(size_t)k] * a[(size_t)(t - k)];
                    db += (double)irB[(size_t)k] * b[(size_t)(t - k)];
                }
                maxErr = std::max(maxErr, std::max(std::fabs(da - ya[(size_t)t]), std::fabs(db - yb[(size_t)t])));
            }
            CHECK(maxErr < 1e-5, "partitioned convolver disagrees with direct convolution");
        }
    }
}

static void testAtemlosHeader(const std::string& jsonPath, const std::string& wavPath) {
    std::ifstream f(jsonPath);
    CHECK(f.good(), ("cannot open " + jsonPath).c_str());
    if (!f.good()) return;
    std::stringstream ss;
    ss << f.rdbuf();
    // Same parse + cast as the original (Helpers.h:880 readFFTCoefficientsFromJSON).
    nlohmann::json data = nlohmann::json::parse(ss.str());
    const auto mid = data["midFIRCoefficients"].get<std::vector<float>>();
    const auto side = data["sideFIRCoefficients"].get<std::vector<float>>();
    CHECK(mid.size() == 8192 && side.size() == 8192, "atemlos.json arrays must have 8192 entries");
    CHECK(std::memcmp(mid.data(), matchering::atemlos::kMidAverageFft, sizeof(float) * 8192) == 0,
          "MatcheringAtemlos.h mid data differs from atemlos.json (regenerate)");
    CHECK(std::memcmp(side.data(), matchering::atemlos::kSideAverageFft, sizeof(float) * 8192) == 0,
          "MatcheringAtemlos.h side data differs from atemlos.json (regenerate)");
    CHECK(data["RMSValue"].get<float>() == matchering::atemlos::kRmsValue, "RMSValue differs (regenerate)");

    const WavData ref = readWavFile(wavPath);
    float peak = 0.0f;
    for (int ch = 0; ch < ref.buffer.getNumChannels(); ++ch)
        for (int i = 0; i < ref.buffer.getNumSamples(); ++i) peak = std::max(peak, std::abs(ref.buffer.getReadPointer(ch)[i]));
    CHECK(peak == matchering::atemlos::kReferencePeak, "reference peak differs (regenerate)");
}

// A 20 s stereo test song with loud and quiet sections and some stereo width.
static AudioBuffer testSong(int frames) {
    AudioBuffer s(2, frames);
    float lpL = 0, lpR = 0;
    for (int i = 0; i < frames; ++i) {
        const float env = (i / 44100) % 6 < 4 ? 0.5f : 0.08f;
        lpL += 0.05f * (noise() - lpL);
        lpR += 0.2f * (noise() - lpR);
        const float tone = 0.3f * std::sin(2.0f * 3.14159265f * 110.0f * i / 44100.0f);
        s.getWritePointer(0)[i] = env * (tone + 2.0f * lpL);
        s.getWritePointer(1)[i] = env * (tone + 1.5f * lpR);
    }
    return s;
}

static AudioBuffer runStream(const matchering::MasteringProfile& p, const AudioBuffer& song,
                             const std::function<int(int)>& blockAt) {
    matchering::MasteringStream st(p);
    const int n = song.getNumSamples(), lat = st.latencyFrames(), total = n + lat;
    AudioBuffer out(2, n);
    int start = 0, call = 0;
    while (start < total) {
        const int len = std::min(blockAt(call++), total - start);
        std::vector<float> iL((size_t)len, 0.0f), iR((size_t)len, 0.0f), oL((size_t)len), oR((size_t)len);
        for (int i = 0; i < len; ++i)
            if (start + i < n) { iL[(size_t)i] = song.getReadPointer(0)[start + i]; iR[(size_t)i] = song.getReadPointer(1)[start + i]; }
        st.process(iL.data(), iR.data(), oL.data(), oR.data(), len);
        for (int i = 0; i < len; ++i) {
            const int t = start + i - lat;
            if (t >= 0 && t < n) { out.getWritePointer(0)[t] = oL[(size_t)i]; out.getWritePointer(1)[t] = oR[(size_t)i]; }
        }
        start += len;
    }
    return out;
}

static bool identical(const AudioBuffer& a, const AudioBuffer& b) {
    for (int ch = 0; ch < 2; ++ch)
        if (std::memcmp(a.getReadPointer(ch), b.getReadPointer(ch), sizeof(float) * (size_t)a.getNumSamples()) != 0) return false;
    return true;
}

static void testStreaming() {
    const AudioBuffer song = testSong(20 * 44100 + 1234);
    for (const auto style : {matchering::Style::Sergree, matchering::Style::BoostAndLimit}) {
        const auto p = matchering::analyze(song, 44100.0, style);
        CHECK(matchering::MasteringStream(p).latencyFrames() ==
                  (style == matchering::Style::Sergree ? matchering::kConvolutionBlock : 0),
              "stream latency");
        const AudioBuffer ref = runStream(p, song, [](int) { return 4096; });
        CHECK(identical(ref, runStream(p, song, [](int) { return 128; })), "stream output depends on block size (128)");
        CHECK(identical(ref, runStream(p, song, [](int) { return 1; })), "stream output depends on block size (1)");
        CHECK(identical(ref, runStream(p, song, [](int c) { return 1 + (c * 7919) % 5000; })),
              "stream output depends on block size (irregular)");
        double sumSq = 0;
        for (int i = 0; i < song.getNumSamples(); ++i) sumSq += (double)ref.getReadPointer(0)[i] * ref.getReadPointer(0)[i];
        CHECK(sumSq > 1.0, "master output is (nearly) silent");
        if (style == matchering::Style::Sergree) {
            CHECK(p.convolvedFrames == (song.getNumSamples() / 4096) * 4096, "convolvedFrames: whole blocks below n - 4096");
            CHECK((int)p.midFir.size() == 4096 && (int)p.sideFir.size() == 4096, "FIR length");
            // The original leaves the unconvolved tail silent before the limiter, so once
            // NC-17's filters have rung out (a few hundred frames) only its tiny
            // denormal-guard noise is left there.
            float tailPeak = 0;
            for (int i = p.convolvedFrames + 2000; i < song.getNumSamples(); ++i) tailPeak = std::max(tailPeak, std::fabs(ref.getReadPointer(0)[i]));
            CHECK(tailPeak < 1e-6f, "frames after convolvedFrames must be (near) silent");
        }
    }
}

static void testErrors() {
    bool threw = false;
    try { matchering::analyze(testSong(16 * 44100), 48000.0, matchering::Style::Sergree); } catch (const std::invalid_argument&) { threw = true; }
    CHECK(threw, "48 kHz must be rejected");
    threw = false;
    try { matchering::analyze(AudioBuffer(1, 16 * 44100), 44100.0, matchering::Style::Sergree); } catch (const std::invalid_argument&) { threw = true; }
    CHECK(threw, "mono must be rejected");
    threw = false;
    try { matchering::analyze(testSong(10 * 44100), 44100.0, matchering::Style::Sergree); } catch (const std::invalid_argument&) { threw = true; }
    CHECK(threw, "a song under 15 s must be rejected until padded");
    threw = false;
    try { matchering::styleFromName("loud"); } catch (const std::invalid_argument&) { threw = true; }
    CHECK(threw, "unknown style must be rejected");

    AudioBuffer shortSong = testSong(4 * 44100 + 17);
    const AudioBuffer orig = shortSong;
    matchering::ensureMinimumLength(shortSong, 44100.0, 15);
    CHECK(shortSong.getNumSamples() == 15 * 44100, "ensureMinimumLength length");
    CHECK(shortSong.getReadPointer(1)[orig.getNumSamples() + 5] == orig.getReadPointer(1)[5], "ensureMinimumLength loops");
}

// The export's offline master (MasterOffline.h): in time with its input (the EQ filters'
// 2048-frame delay compensated) and true peaks held at -1 dBTP.
static void testOfflineMaster() {
    const AudioBuffer song = testSong(20 * 44100);
    const auto p = matchering::analyze(song, 44100.0, matchering::Style::Sergree);
    const matchering::OfflineMaster m = matchering::masterOffline(song, p);
    CHECK(m.out.getNumSamples() == song.getNumSamples(), "offline master keeps the length");
    // Best-matching lag of the output against the input (mid channel, 4 s from 2 s in).
    int bestLag = 9999;
    double best = -1e30;
    for (int lag = -3000; lag <= 3000; ++lag) {
        double c = 0;
        for (int i = 2 * 44100; i < 6 * 44100; i += 3) c += (double)song.getReadPointer(0)[i] * m.out.getReadPointer(0)[i + lag];
        if (c > best) { best = c; bestLag = lag; }
    }
    std::printf("offline master: lag %d frames, true peak %.2f -> %.2f dBTP\n", bestLag, m.truePeakInDb, m.truePeakOutDb);
    CHECK(std::abs(bestLag) <= 2, "offline master output is not in time with its input");
    CHECK(m.truePeakOutDb <= matchering::kTruePeakCeilingDb + 0.05f, "true peak above the ceiling");
    CHECK(matchering::offline_detail::truePeakDb(m.out) <= matchering::kTruePeakCeilingDb + 0.05f, "measured true peak above the ceiling");
}

int main(int argc, char** argv) {
    if (argc != 3) {
        std::fprintf(stderr, "usage: matchering_test <atemlos.json> <referenceAtemlos.wav>\n");
        return 2;
    }
    testFft();
    testConvolver();
    testAtemlosHeader(argv[1], argv[2]);
    testStreaming();
    testErrors();
    testOfflineMaster();
    if (failures) {
        std::fprintf(stderr, "matchering_test: %d failure(s)\n", failures);
        return 1;
    }
    std::printf("matchering_test: OK\n");
    return 0;
}
