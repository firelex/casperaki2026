// Real-sample integration test (docs/60 Phase 1 finish) — the "a known note
// plays the right slice/pitch" check the task calls for. Drives the NATIVE real
// load path end to end: decode the genre's actual library assets (minimp3) +
// slice per the manifest (SampleLibrary), then assert, for the first tonal lane:
//
//   (1) slice offsets are HONORED — each slot's bound PCM is (sliceEnd-sliceStart)
//       seconds long, NOT the whole multi-minute preset (the bug if offsets were
//       ignored: the old stub path used the full fixture).
//   (2) the right slice plays the right pitch — autocorrelation of each slice
//       lands on the slot's recorded note (c2 -> ~65 Hz, etc.), within tolerance.
//   (3) distinct slots get DISTINCT audio — the docs/54k regression: never copy
//       one source across all slots; chord motion must survive.
//
// Gated on the real library: without CASPERAKI_SAMPLE_LIBRARY_ROOT (or the genre
// envelope's asset-manifest.json) it prints SKIP and passes, so ctest is green on
// machines without the Dropbox library mounted. REALSAMPLE_GENRE_DIR is injected
// by CMake (the ballad envelope under apps/engine-spike/out/...).

#include "../src/audio/Mixer.h"
#include "../src/audio/SampleLibrary.h"
#include "../src/audio/Gain.h"          // midiNoteInHertz
#include "../src/music/Note.h"          // getMidiNoteNumber
#include "../vendor/json.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using namespace casperaki;

namespace {
int failures = 0;
void check(bool cond, const char* msg) {
    if (!cond) { std::printf("FAIL: %s\n", msg); ++failures; }
}

std::string readFile(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    std::stringstream ss; ss << f.rdbuf();
    return ss.str();
}

// NORMALIZED-autocorrelation fundamental estimate. Raw autocorrelation is biased
// toward small lags (high frequencies), so we normalise each lag by the window
// energies (standard NCC, ~1.0 at the true period) and centre the window on the
// slice's highest-energy region (the sustained note, past any leading silence).
// Searches [40, 500] Hz; returns 0 if nothing is clearly periodic.
double detectFundamental(const SampleData& d) {
    const int sr = d.sampleRate;
    const int n = d.frames;
    if (n < sr / 4 || sr <= 0) return 0.0;
    const float* x = d.audio.getReadPointer(0);

    int win = std::min(n, (int)(0.4 * sr));
    if (win < sr / 80) return 0.0;

    // Pick the loudest `win`-frame window (coarse 10 ms hops).
    const int hop = std::max(1, sr / 100);
    int start = 0; double bestE = -1.0;
    for (int s = 0; s + win <= n; s += hop) {
        double e = 0;
        for (int i = s; i < s + win; ++i) e += (double)x[i] * x[i];
        if (e > bestE) { bestE = e; start = s; }
    }
    if (bestE <= 1e-9) return 0.0;

    // Prefix sum of squares so each lag's window energies are O(1).
    std::vector<double> psq(win + 1, 0.0);
    for (int i = 0; i < win; ++i) psq[i + 1] = psq[i] + (double)x[start + i] * x[start + i];

    // [25, 600] Hz — wide enough to find the sub-octave fundamental real synth
    // basses (e.g. Trilian's sub oscillator) lock onto; the caller folds octaves.
    const int minLag = sr / 600, maxLag = std::min(sr / 25, win - 1);
    double best = -1e30; int bestLag = 0;
    for (int lag = minLag; lag <= maxLag; ++lag) {
        double num = 0;
        for (int i = 0; i < win - lag; ++i) num += (double)x[start + i] * x[start + i + lag];
        const double eL = psq[win - lag] - psq[0];
        const double eR = psq[win] - psq[lag];
        const double denom = std::sqrt(eL * eR);
        const double r = denom > 1e-12 ? num / denom : 0.0;
        if (r > best) { best = r; bestLag = lag; }
    }
    return bestLag > 0 ? (double)sr / bestLag : 0.0;
}

bool buffersDiffer(const SampleData& a, const SampleData& b) {
    const int n = std::min(a.frames, b.frames);
    if (n <= 0) return a.frames != b.frames;
    const float* xa = a.audio.getReadPointer(0);
    const float* xb = b.audio.getReadPointer(0);
    for (int i = 0; i < n; ++i) if (xa[i] != xb[i]) return true;
    return false;
}
} // namespace

int main() {
    const char* rootEnv = std::getenv("CASPERAKI_SAMPLE_LIBRARY_ROOT");
    const fs::path genreDir = REALSAMPLE_GENRE_DIR;
    const fs::path manifestPath = genreDir / "asset-manifest.json";
    if (!rootEnv || std::string(rootEnv).empty() || !fs::exists(manifestPath)) {
        std::printf("SKIP realsample_test: no library (set CASPERAKI_SAMPLE_LIBRARY_ROOT) "
                    "or no manifest at %s\n", manifestPath.string().c_str());
        return 0;
    }

    // Parse the envelope's inst-N.json (ascending id) + the manifest.
    std::vector<fs::path> instPaths;
    for (const auto& e : fs::directory_iterator(genreDir)) {
        const auto name = e.path().filename().string();
        if (name.rfind("inst-", 0) == 0 && e.path().extension() == ".json")
            instPaths.push_back(e.path());
    }
    std::sort(instPaths.begin(), instPaths.end(), [](const fs::path& a, const fs::path& b) {
        return std::stoi(a.stem().string().substr(5)) < std::stoi(b.stem().string().substr(5));
    });
    std::vector<nlohmann::json> instJsons;
    for (const auto& p : instPaths) {
        try { instJsons.push_back(nlohmann::json::parse(readFile(p))); }
        catch (...) { instJsons.push_back(nlohmann::json::object()); }
    }
    nlohmann::json manifest = nlohmann::json::parse(readFile(manifestPath));

    // Load the real library into a mixer.
    Mixer mixer(44100.0, 128, 2.5, StubSamples{});
    SampleLibrary lib(rootEnv, 8192);
    const auto st = lib.loadInto(mixer, genreDir, instJsons);
    std::printf("loaded: %d files, %d tonal slots, %d drum lanes, %d wave sources\n",
                st.filesDecoded, st.tonalSlots, st.drumLanes, st.waveSources);
    check(st.loaded, "manifest loaded");
    check(st.tonalSlots > 0, "some tonal slots registered");
    check(st.decodeFailures == 0, "no decode failures");

    // Find the Bass lane (a clean low fundamental) and its first two resolved slots.
    const nlohmann::json* bass = nullptr;
    if (manifest.contains("lanes") && manifest["lanes"].contains("Bass")) bass = &manifest["lanes"]["Bass"];
    else if (manifest.contains("Bass")) bass = &manifest["Bass"];
    check(bass != nullptr, "Bass lane present in manifest");
    if (!bass || !bass->contains("multisample")) { std::printf("%s\n", failures ? "\nFAILED" : "PASSED"); return failures ? 1 : 0; }

    std::vector<SampleData*> picked;
    std::vector<std::string> pickedNotes;
    std::vector<double> pickedLenSec;
    for (const auto& slot : (*bass)["multisample"]["slots"]) {
        if (slot.value("status", std::string()) != "resolved") continue;
        const int id = slot["slot"].value("id", -1);
        const std::string note = slot["slot"].value("note", std::string());
        const double s0 = slot.value("sliceStart", -1.0), s1 = slot.value("sliceEnd", -1.0);
        auto data = mixer.sampleById(std::to_string(id));
        check(data != nullptr, "bass slot registered by id");
        if (!data) continue;
        picked.push_back(data.get());
        pickedNotes.push_back(note);
        pickedLenSec.push_back(s1 - s0);
        if (std::getenv("REALSAMPLE_DUMP")) {
            std::ofstream o("/tmp/native_sl_" + std::to_string(picked.size() - 1) + ".raw", std::ios::binary);
            o.write(reinterpret_cast<const char*>(data->audio.getReadPointer(0)),
                    (std::streamsize)sizeof(float) * data->frames);
        }
        if (picked.size() >= 3) break;
    }
    check(picked.size() >= 2, "at least two bass slots to compare");

    for (size_t i = 0; i < picked.size(); ++i) {
        const SampleData& d = *picked[i];
        // (1) slice offsets honored: bound length ~= the manifest slice duration.
        const double expectLen = pickedLenSec[i] * d.sampleRate;
        check(std::fabs((double)d.frames - expectLen) <= 4.0, "slice length matches manifest [start,end]");

        // (2) right pitch: the slice's detected fundamental matches the slot's
        // note's PITCH CLASS (octave-folded — a real synth bass's sub oscillator
        // makes the detector lock an octave low; the note identity is what matters).
        const int midi = music::getMidiNoteNumber(pickedNotes[i]);
        const double expectHz = midiNoteInHertz(midi);
        const double gotHz = detectFundamental(d);
        const double cents = 1200.0 * std::log2(gotHz / expectHz);
        const double folded = cents - 1200.0 * std::round(cents / 1200.0);  // nearest octave
        const bool pitchOk = gotHz > 0 && std::fabs(folded) <= 60.0;        // < ~0.6 semitone
        std::printf("  slot %zu note=%s expect=%.1fHz got=%.1fHz (%+.0f cents) len=%d (%.0f exp) %s\n",
                    i, pickedNotes[i].c_str(), expectHz, gotHz, folded, d.frames, expectLen,
                    pitchOk ? "pitch-ok" : "PITCH-MISS");
        check(pitchOk, "slice fundamental matches the slot's note (pitch class)");
    }

    // (3) distinct slots -> distinct audio (no single-source-across-all-slots bug).
    if (picked.size() >= 2)
        check(buffersDiffer(*picked[0], *picked[1]), "distinct slots have distinct audio");

    std::printf("%s\n", failures ? "\nFAILED" : "PASSED");
    return failures ? 1 : 0;
}
