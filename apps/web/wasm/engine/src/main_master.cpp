// casperaki_master <in.wav> <out.wav> <sergree|boost> [reference.json]
//
// reference.json (casperaki_master_reference's output): master towards that reference instead of Atemlos (a genre
// recipe's own, e.g. Casperaki Pop; docs/superpowers/specs/2026-11-28-genre-recipes-design.md).
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
#include "../vendor/json.hpp"

#include <chrono>
#include <cstdio>
#include <exception>
#include <fstream>
#include <string>
#include <vector>

using namespace casperaki;

int main(int argc, char** argv) {
    if (argc != 4 && argc != 5) {
        std::fprintf(stderr, "usage: casperaki_master <in.wav> <out.wav> <sergree|boost> [reference.json]\n");
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

        // The reference: Atemlos, or the file given (its spectra kept alive for the analysis).
        std::vector<float> refMid, refSide;
        matchering::Reference reference = matchering::atemlosReference();
        if (argc == 5) {
            std::ifstream f(argv[4]);
            if (!f) throw std::runtime_error(std::string("cannot read the reference ") + argv[4]);
            const nlohmann::json j = nlohmann::json::parse(f);
            refMid = j.at("mid").get<std::vector<float>>();
            refSide = j.at("side").get<std::vector<float>>();
            if (refMid.size() != (size_t)matchering::kFftSize * 2 || refSide.size() != (size_t)matchering::kFftSize * 2)
                throw std::runtime_error(std::string("the reference ") + argv[4] + " must have 8192 mid and side values");
            reference = {refMid.data(), refSide.data(), j.at("rms").get<float>(), j.at("peak").get<float>()};
        }
        const matchering::MasteringProfile profile = matchering::analyze(song, matchering::kSampleRate, style, reference);
        const auto t1 = std::chrono::steady_clock::now();

        // In time with the input (matchering::applyOffline compensates the filters' delay).
        const AudioBuffer out = matchering::applyOffline(song, profile);
        const int n = out.getNumSamples();
        const matchering::MasteringStream probe(profile);
        const int latency = probe.latencyFrames() + probe.filterDelayFrames();  // what applyOffline compensated
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
