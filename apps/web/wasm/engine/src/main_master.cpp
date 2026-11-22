// casperaki_master <in.wav> <out.wav> <sergree|boost>
//
// Offline mastering with the matchering port (audio/Matchering.h). The JUCE original it
// reproduces is masterSongAtemlos(in, out, shouldMaster = true, shouldLimit = style ==
// "boost") (casperaki_engine/dependencies/matchering/Source/Matchering.h:1881), the same
// call apps/engine-spike's casperaki_matchering_smoke makes.
//
// It runs exactly the two steps the live path will run: analyze() over the whole song,
// then MasteringStream block by block (fixed 512-frame blocks here; the result does not
// depend on the block size). Output is 24-bit PCM (round to nearest), like the
// original's 24-bit export (Helpers.h:796 exportFileToWAV).
#include "audio/Matchering.h"
#include "audio/WavFile.h"

#include <chrono>
#include <cstdio>
#include <exception>
#include <string>
#include <vector>

using namespace casperaki;

int main(int argc, char** argv) {
    if (argc != 4) {
        std::fprintf(stderr, "usage: casperaki_master <in.wav> <out.wav> <sergree|boost>\n");
        return 1;
    }
    try {
        const std::string inPath = argv[1], outPath = argv[2];
        const matchering::Style style = matchering::styleFromName(argv[3]);
        const auto t0 = std::chrono::steady_clock::now();

        WavData in = readWavFile(inPath);
        if (in.sampleRate != (int)matchering::kSampleRate)
            throw std::runtime_error("input must be 44100 Hz (matchering is locked to it), got " +
                                     std::to_string(in.sampleRate) + " Hz: " + inPath);
        if (in.buffer.getNumChannels() != 2)
            throw std::runtime_error("input must be stereo, got " + std::to_string(in.buffer.getNumChannels()) +
                                     " channel(s): " + inPath);
        AudioBuffer song = in.buffer;
        // Matchering.h:1910 checkAndEnsureMinimumLengthInSeconds (target, 44100, 15).
        matchering::ensureMinimumLength(song, matchering::kSampleRate, matchering::kMinLengthSeconds);

        const matchering::MasteringProfile profile = matchering::analyze(song, matchering::kSampleRate, style);
        const auto t1 = std::chrono::steady_clock::now();

        matchering::MasteringStream stream(profile);
        const int latency = stream.latencyFrames();
        const int n = song.getNumSamples();
        const int total = n + latency;
        AudioBuffer out(2, n);
        const int block = 512;
        std::vector<float> zeros((size_t)block, 0.0f), oL((size_t)block), oR((size_t)block);
        for (int start = 0; start < total; start += block) {
            const int len = std::min(block, total - start);
            const int fromSong = std::max(0, std::min(len, n - start));
            std::vector<float> iL((size_t)len, 0.0f), iR((size_t)len, 0.0f);
            if (fromSong > 0) {
                std::copy(song.getReadPointer(0, start), song.getReadPointer(0, start) + fromSong, iL.begin());
                std::copy(song.getReadPointer(1, start), song.getReadPointer(1, start) + fromSong, iR.begin());
            }
            stream.process(iL.data(), iR.data(), oL.data(), oR.data(), len);
            for (int i = 0; i < len; ++i) {
                const int t = start + i - latency;  // output frame t belongs to song frame t - latency
                if (t >= 0 && t < n) {
                    out.getWritePointer(0)[t] = oL[(size_t)i];
                    out.getWritePointer(1)[t] = oR[(size_t)i];
                }
            }
        }
        const auto t2 = std::chrono::steady_clock::now();
        writeWav24File(outPath, out, (int)matchering::kSampleRate);

        const auto ms = [](auto a, auto b) { return std::chrono::duration<double, std::milli>(b - a).count(); };
        std::printf("[master] style=%s frames=%d latency=%d analyze=%.0fms apply=%.0fms\n", argv[3], n, latency,
                    ms(t0, t1), ms(t1, t2));
        if (style == matchering::Style::Sergree)
            std::printf("[master] targetMatchRms=%.9g referenceMatchRms=%.9g rmsCoefficient=%.9g pieces mid=%d side=%d "
                        "convolvedFrames=%d preLimiterGain=%.9g finalGain=%.9g\n",
                        profile.targetMatchRms, profile.referenceMatchRms, profile.rmsCoefficient, profile.numMidPieces,
                        profile.numSidePieces, profile.convolvedFrames, profile.preLimiterGain, profile.finalGain);
        else
            std::printf("[master] preLimiterGain=%.9g\n", profile.preLimiterGain);
        return 0;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "casperaki_master: %s\n", e.what());
        return 2;
    }
}
