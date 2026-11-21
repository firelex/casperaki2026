// Native offline render CLI — the headline deliverable of Phase 1's sampler/mix
// half. Reads a genre envelope directory (song.json + inst-N.json), resolves it
// to the IR, then renders a stereo master WAV (NO FX) via the ported sampler.
//
//   usage: casperaki_render <envelope-dir> <out.wav> [samples-dir] [library-root]
//
// samples-dir defaults to apps/engine-spike/samples (the bundled stub fixtures).
// library-root (docs/60 Phase 1 finish) is the real sample library root the
// envelope's asset-manifest.json resolves against — when given (or via the
// CASPERAKI_SAMPLE_LIBRARY_ROOT env var) the render plays the REAL multisample
// library (sliced per slot), falling back to the stubs for any unresolved asset.
// Without it the render is the stub-sampled output (byte-identical to before).
// The output is a real, non-silent, full-length stereo WAV whose energy lands
// where the resolved IR places notes/clips — verify with scripts/validate-audio.mjs
// (and listen).

#include "Resolver.h"
#include "Serialize.h"
#include "audio/Render.h"
#include "audio/WavIO.h"
#include "../vendor/json.hpp"

#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;

static std::string readFile(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    if (!f) throw std::runtime_error("cannot open " + p.string());
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "usage: casperaki_render <envelope-dir> <out.wav> [samples-dir] [library-root]\n";
        return 2;
    }
    const fs::path dir = fs::absolute(argv[1]);
    const std::string outPath = argv[2];

    // Real sample library root: explicit 4th arg wins, else the env var, else
    // empty (= stub-sampled render, the byte-identical no-library path).
    std::string libraryRoot;
    if (argc >= 5) libraryRoot = argv[4];
    else if (const char* env = std::getenv("CASPERAKI_SAMPLE_LIBRARY_ROOT")) libraryRoot = env;

    // Default to the bundled stub fixtures relative to the repo layout.
    std::string samplesDir;
    if (argc >= 4) {
        samplesDir = argv[3];
    } else {
        // engine dir is apps/web/wasm/engine; samples live at apps/engine-spike/samples
        fs::path guess = fs::path(argv[0]).parent_path();
        // Walk up to the repo root heuristically; fall back to a relative path.
        samplesDir = (dir.parent_path().parent_path().parent_path().parent_path()
                      / "engine-spike" / "samples").string();
    }

    std::string songJson;
    try {
        songJson = readFile(dir / "song.json");
    } catch (const std::exception& e) {
        std::cerr << "error: " << e.what() << "\n";
        return 2;
    }

    // Collect inst-N.json in ascending numeric id order (matches the resolver).
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
        try {
            instJsons.push_back(nlohmann::json::parse(s));
        } catch (...) {
            instJsons.push_back(nlohmann::json::object());
        }
    }

    try {
        casperaki::Resolver resolver;
        const auto ev = resolver.resolve(songJson, instStrings);

        casperaki::RenderConfig cfg;
        cfg.samplesDir = samplesDir;
        cfg.libraryRoot = libraryRoot;
        cfg.genreDir = dir.string();
        // Phase 2 Scope A: opt into the per-instrument-group mix (per-lane gainDb)
        // via CASPERAKI_MIX=1. Default off -> byte-identical to the Phase-1 render.
        if (const char* m = std::getenv("CASPERAKI_MIX"))
            cfg.mixEnabled = (std::string(m) == "1" || std::string(m) == "true");
        if (const char* nn = std::getenv("CASPERAKI_NO_NORM"))
            cfg.noNormalize = (std::string(nn) == "1" || std::string(nn) == "true");
        // docs/64 — shared mix config. CASPERAKI_MIX_CONFIG overrides; default is the
        // sibling casperaki_engine repo. Only consulted when mixEnabled; if missing,
        // the engine falls back to the compiled-in tables (identical values).
        if (const char* mc = std::getenv("CASPERAKI_MIX_CONFIG")) cfg.mixConfigPath = mc;
        else {
            const std::string def =
                "/home/roli79/apps/casperaki_engine/config/mix-config.json";
            if (std::filesystem::exists(def)) cfg.mixConfigPath = def;
        }
        casperaki::Renderer renderer(cfg);
        const auto master = renderer.render(ev, instJsons);

        // 16-bit by default (keeps the existing guards/fixtures stable); CASPERAKI_BITS=24
        // writes 24-bit PCM to match the native golden's depth (A/B + cleaner master).
        bool bits24 = false;
        if (const char* b = std::getenv("CASPERAKI_BITS")) bits24 = (std::string(b) == "24");
        const bool wrote = bits24 ? casperaki::writeWav24(outPath, master, (int)cfg.sampleRate)
                                  : casperaki::writeWav16(outPath, master, (int)cfg.sampleRate);
        if (!wrote) {
            std::cerr << "error: cannot write " << outPath << "\n";
            return 1;
        }

        const double durSec = master.getNumSamples() / cfg.sampleRate;
        const auto& ls = renderer.lastLibraryStats();
        std::cerr << "rendered " << ev.genre << ": " << master.getNumSamples()
                  << " frames (" << durSec << " s), " << ev.tracks.size()
                  << " tracks -> " << outPath << "  [samples: " << samplesDir << "]\n";
        // The browser player matches this WAV's level by using this as its fixed
        // master gain (mixer_set_master_gain).
        std::cerr << "  normalize gain: " << renderer.lastNormalizeGain()
                  << " (mix " << (cfg.mixEnabled ? "on" : "off") << ")\n";
        if (ls.loaded)
            std::cerr << "  real library [" << libraryRoot << "]: "
                      << ls.filesDecoded << " files decoded (" << ls.decodeFailures << " failed), "
                      << ls.tonalSlots << " tonal slots, " << ls.drumLanes << " drum lanes, "
                      << ls.waveSources << " wave sources, "
                      << ls.fretSlots << " fret slots, " << ls.strumSamples << " strums"
                      << " (missing: " << ls.tonalMissing << "/" << ls.drumMissing
                      << "/" << ls.waveMissing << "/" << ls.fretMissing
                      << "/" << ls.strumMissing << ")\n";
        else if (!libraryRoot.empty())
            std::cerr << "  real library requested but asset-manifest.json not found in "
                      << dir.string() << " — stub-sampled render\n";
    } catch (const std::exception& e) {
        std::cerr << "render error: " << e.what() << "\n";
        return 1;
    }
    return 0;
}
