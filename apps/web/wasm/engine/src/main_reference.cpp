// casperaki_master_reference <reference.wav> <out.json>
//
// A mastering reference's data, as the original matchering keeps Atemlos's (atemlos.json, compiled into
// audio/MatcheringAtemlos.h): the reference normalised to full scale (Matchering.h:227 normalizeAudioBuffer), split
// into mid and side (M.h:136), its match RMS (M.h:254 analyzeLevelsForMatchRMS, the "SAVING OPTIMISATION" the original
// precomputed) and the average FFT of its loudest 15 s mid / side pieces (M.h:276-277, then averageFft). The same
// functions the port runs on the song (audio/Matchering.h detail::), so a reference made here masters a song as
// Atemlos does. casperaki_master takes the file as its fourth argument. Genre recipes name their reference
// (docs/superpowers/specs/2026-11-28-genre-recipes-design.md; Casperaki Pop, owner 2026-11-28).
#include "audio/Matchering.h"
#include "audio/WavFile.h"

#include <cmath>
#include <cstdio>
#include <exception>
#include <fstream>
#include <string>
#include <vector>

using namespace casperaki;

int main(int argc, char** argv) {
    if (argc != 3) {
        std::fprintf(stderr, "usage: casperaki_master_reference <reference.wav> <out.json>\n");
        return 1;
    }
    try {
        WavData in = readWavFile(argv[1]);
        if (in.sampleRate != (int)matchering::kSampleRate)
            throw std::runtime_error("the reference must be 44100 Hz, got " + std::to_string(in.sampleRate));
        if (in.buffer.getNumChannels() != 2)
            throw std::runtime_error("the reference must be stereo, got " + std::to_string(in.buffer.getNumChannels()) + " channel(s)");
        AudioBuffer ref = in.buffer;
        matchering::ensureMinimumLength(ref, matchering::kSampleRate, matchering::kMinLengthSeconds);
        float peak = 0.0f;
        for (int c = 0; c < 2; ++c) {
            const float* d = ref.getReadPointer(c);
            for (int i = 0; i < ref.getNumSamples(); ++i) peak = std::max(peak, std::fabs(d[i]));
        }
        if (peak <= 0.0f) throw std::runtime_error("the reference is silent");
        // normalizeAudioBuffer: a quiet reference is brought up to full scale (divided by its coefficient).
        const float coefficient = matchering::detail::normalizationCoefficient(peak);
        for (int c = 0; c < 2; ++c) {
            float* d = ref.getWritePointer(c);
            for (int i = 0; i < ref.getNumSamples(); ++i) d[i] /= coefficient;
        }
        std::vector<float> mid, side;
        matchering::detail::midAndSide(ref, mid, side);
        const float rms = matchering::detail::analyzeLevelsForMatchRms(mid);
        const int segment = (int)(matchering::kSampleRate * matchering::kPieceSeconds);
        const auto midPieces = matchering::detail::loudestSegmentsAboveAverageRms(mid, segment);
        const auto sidePieces = matchering::detail::loudestSegmentsAboveAverageRms(side, segment);
        dsp::RealFft fft(12);
        const std::vector<float> midFft = matchering::detail::averageFft(midPieces, fft);
        const std::vector<float> sideFft = matchering::detail::averageFft(sidePieces, fft);

        std::ofstream out(argv[2]);
        if (!out) throw std::runtime_error(std::string("cannot write ") + argv[2]);
        out.precision(9);
        out << "{\n \"rms\": " << rms << ",\n \"peak\": " << peak << ",\n \"midPieces\": " << midPieces.size()
            << ",\n \"sidePieces\": " << sidePieces.size() << ",\n \"mid\": [";
        for (size_t i = 0; i < midFft.size(); ++i) out << (i ? "," : "") << midFft[i];
        out << "],\n \"side\": [";
        for (size_t i = 0; i < sideFft.size(); ++i) out << (i ? "," : "") << sideFft[i];
        out << "]\n}\n";
        std::printf("[reference] rms=%.9g peak=%.9g pieces mid=%zu side=%zu\n", rms, peak, midPieces.size(), sidePieces.size());
        return 0;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "casperaki_master_reference: %s\n", e.what());
        return 2;
    }
}
