// Native mixer probe — the headless parity reference for the WASM streaming
// mixer (docs/60 Phase 1 step 6). Renders the FIRST N blocks of a genre straight
// from the streaming Mixer (no peak-normalise, master gain 1.0) into a raw
// float32 dump, using stub PCM read from a file rather than decoded oggs — so the
// WASM build can be fed byte-identical PCM and the two pull paths diffed
// bit-for-bit (modulo libm). This is the native side of scripts/validate-wasm-parity.mjs.
//
//   usage: casperaki_mixer_probe <envelope-dir> <stub-pcm-file> <numBlocks> <out-raw>
//                                [--mix <mix-config.json>] [--seek <frame> <prerollFrames>]
//                                [--meters <binFrames> <out.json>]
//
// --mix turns on the per-lane mix + rack FX with that config (= CASPERAKI_MIX=1).
// --seek calls Mixer::seek(frame, prerollFrames) before pulling, so the dump is
// numBlocks starting at `frame` (the seek parity check diffs it against the same
// span of an unseeked dump).
// --meters turns on the per-lane meters and writes {"binFrames", "lanes":
// [{"name", "peak": [...], "rms": [...]}]} (the bins the pulled span covers).
//
// stub-pcm-file: 5 roles (kick,snare,hat,tone,bass) in order, each
//   int32 frames, int32 channels, int32 sampleRate, then channels*frames float32
//   (planar). out-raw: numBlocks * (2 * 128) float32, planar per block (L then R).

#include "Resolver.h"
#include "audio/MixConfig.h"
#include "audio/Mixer.h"
#include "../vendor/json.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using namespace casperaki;

static std::string readFile(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    if (!f) throw std::runtime_error("cannot open " + p.string());
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

static std::shared_ptr<SampleData> readStub(std::ifstream& f) {
    int32_t frames = 0, channels = 0, sampleRate = 0;
    f.read(reinterpret_cast<char*>(&frames), 4);
    f.read(reinterpret_cast<char*>(&channels), 4);
    f.read(reinterpret_cast<char*>(&sampleRate), 4);
    auto data = std::make_shared<SampleData>();
    const int pad = 8192;
    if (channels < 1) channels = 1;
    if (channels > 2) channels = 2;
    data->audio.setSize(channels, frames + pad);
    for (int ch = 0; ch < channels; ++ch)
        f.read(reinterpret_cast<char*>(data->audio.getWritePointer(ch)),
               (std::streamsize)sizeof(float) * frames);
    data->frames = frames;
    data->sampleRate = sampleRate;
    return data;
}

int main(int argc, char** argv) {
    if (argc < 5) {
        std::cerr << "usage: casperaki_mixer_probe <envelope-dir> <stub-pcm-file> <numBlocks> <out-raw>\n";
        return 2;
    }
    const fs::path dir = fs::absolute(argv[1]);
    const std::string pcmPath = argv[2];
    const int numBlocks = std::stoi(argv[3]);
    const std::string outPath = argv[4];
    const int blockSize = 128;

    std::string mixConfigPath;
    long seekFrame = -1, seekPreroll = 0;
    int meterBin = 0;
    std::string meterPath;
    for (int i = 5; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--mix" && i + 1 < argc) mixConfigPath = argv[++i];
        else if (a == "--seek" && i + 2 < argc) {
            seekFrame = std::stol(argv[++i]);
            seekPreroll = std::stol(argv[++i]);
        } else if (a == "--meters" && i + 2 < argc) {
            meterBin = std::stoi(argv[++i]);
            meterPath = argv[++i];
        } else {
            std::cerr << "probe error: unknown or incomplete argument " << a << "\n";
            return 2;
        }
    }

    try {
        // --- stub PCM (byte-identical to what the WASM harness feeds) ---
        std::ifstream pf(pcmPath, std::ios::binary);
        if (!pf) throw std::runtime_error("cannot open " + pcmPath);
        StubSamples stubs;
        stubs.kick = readStub(pf);
        stubs.snare = readStub(pf);
        stubs.hat = readStub(pf);
        stubs.tone = readStub(pf);
        stubs.bass = readStub(pf);

        // --- genre envelope ---
        const std::string songJson = readFile(dir / "song.json");
        std::vector<fs::path> instPaths;
        for (const auto& e : fs::directory_iterator(dir)) {
            const auto name = e.path().filename().string();
            if (name.rfind("inst-", 0) == 0 && e.path().extension() == ".json")
                instPaths.push_back(e.path());
        }
        std::sort(instPaths.begin(), instPaths.end(), [](const fs::path& a, const fs::path& b) {
            auto n = [](const fs::path& p) { return std::stoi(p.stem().string().substr(5)); };
            return n(a) < n(b);
        });
        std::vector<std::string> instStrings;
        std::vector<nlohmann::json> instJsons;
        for (const auto& p : instPaths) {
            std::string s = readFile(p);
            instStrings.push_back(s);
            try { instJsons.push_back(nlohmann::json::parse(s)); }
            catch (...) { instJsons.push_back(nlohmann::json::object()); }
        }

        Resolver resolver;
        ResolvedEvents ev = resolver.resolve(songJson, instStrings);

        Mixer mixer(44100.0, blockSize, 2.5, stubs);
        std::unique_ptr<mix::MixConfig> mixCfg;
        if (!mixConfigPath.empty()) {
            mixCfg = std::make_unique<mix::MixConfig>(mix::MixConfig::fromFile(mixConfigPath));
            mixer.setMixEnabled(true);
            mixer.setMixConfig(*mixCfg);
        }
        if (meterBin > 0) mixer.enableMeters(meterBin);
        mixer.build(ev, instJsons);
        if (seekFrame >= 0) mixer.seek(seekFrame, seekPreroll);

        std::ofstream out(outPath, std::ios::binary);
        if (!out) throw std::runtime_error("cannot write " + outPath);
        AudioBuffer block(2, blockSize);
        for (int b = 0; b < numBlocks; ++b) {
            mixer.pullBlock(block, blockSize);
            for (int ch = 0; ch < 2; ++ch)
                out.write(reinterpret_cast<const char*>(block.getReadPointer(ch)),
                          (std::streamsize)sizeof(float) * blockSize);
        }
        if (meterBin > 0) {
            const long pulled = (long)numBlocks * blockSize;
            const int bins = (int)std::min<long>(mixer.meterBinCount(), (pulled + meterBin - 1) / meterBin);
            nlohmann::json j;
            j["binFrames"] = meterBin;
            j["lanes"] = nlohmann::json::array();
            for (int l = 0; l < mixer.laneCount(); ++l) {
                nlohmann::json lane;
                lane["name"] = mixer.laneName(l);
                lane["peak"] = std::vector<float>(mixer.lanePeaks(l), mixer.lanePeaks(l) + bins);
                lane["rms"] = std::vector<float>(mixer.laneRms(l), mixer.laneRms(l) + bins);
                j["lanes"].push_back(std::move(lane));
            }
            std::ofstream mf(meterPath);
            if (!mf) throw std::runtime_error("cannot write " + meterPath);
            mf << j.dump();
        }
        std::cerr << "probe " << ev.genre << ": " << numBlocks << " blocks, "
                  << mixer.totalFrames() << " total frames -> " << outPath << "\n";
    } catch (const std::exception& e) {
        std::cerr << "probe error: " << e.what() << "\n";
        return 1;
    }
    return 0;
}
