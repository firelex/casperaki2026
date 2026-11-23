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
#include "audio/MasterOffline.h"
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

        // Aligned and true-peak limited (audio/MasterOffline.h).
        const matchering::OfflineMaster mastered = matchering::masterOffline(song, profile);
        const AudioBuffer& out = mastered.out;
        const int n = out.getNumSamples();
        const auto t2 = std::chrono::steady_clock::now();
        writeWav24File(outPath, out, (int)matchering::kSampleRate);

        const auto ms = [](auto a, auto b) { return std::chrono::duration<double, std::milli>(b - a).count(); };
        std::printf("[master] style=%s frames=%d analyze=%.0fms apply=%.0fms\n", argv[3], n, ms(t0, t1), ms(t1, t2));
        std::printf("[master] bassLimitDb=%.2f truePeakIn=%.2f truePeakOut=%.2f\n", mastered.bassLimitDb,
                    mastered.truePeakInDb, mastered.truePeakOutDb);
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
