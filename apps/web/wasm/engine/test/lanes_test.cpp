// Instrument lanes, lane meters and live lane gain (Mixer::laneCount/laneName,
// enableMeters/lanePeaks/laneRms, setLaneGain). Uses the latin envelope (Drums
// splits into 4 step tracks, Guitar into 4 tracks — both must be ONE lane) with
// synthetic stub PCM:
//   1. lane names are the inst-N.json names (+ "Sample Transitions FX"), one each;
//   2. a lane's meters equal the master of a solo render of that lane (mix off,
//      where master == sum of lanes), bin for bin;
//   3. gain 0 silences: all lanes muted -> master exactly 0 after the ramp (mix
//      off); one lane muted with the mix on -> its meters are 0 after the ramp
//      and the master changes.
#include "../src/Resolver.h"
#include "../src/audio/MixConfig.h"
#include "../src/audio/Mixer.h"
#include "../vendor/json.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <set>
#include <sstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using namespace casperaki;

namespace {
int failures = 0;
void check(bool cond, const std::string& msg) {
    if (!cond) { std::printf("FAIL: %s\n", msg.c_str()); ++failures; }
}

std::string readFile(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    if (!f) throw std::runtime_error("cannot open " + p.string());
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

std::shared_ptr<SampleData> stub(int role) {
    auto d = std::make_shared<SampleData>();
    const int frames = 8000, pad = 8192;
    d->audio.setSize(1, frames + pad);
    float* x = d->audio.getWritePointer(0);
    const double f0 = 80 + role * 37;
    for (int i = 0; i < frames; ++i)
        x[i] = (float)((1.0 - (double)i / frames) * 0.6 * std::sin(2 * M_PI * f0 * i / 44100.0));
    d->frames = frames;
    d->sampleRate = 44100;
    return d;
}

constexpr int kBlock = 128, kBin = 1024;
constexpr long kFrames = 60L * 44100;  // first 60 s (every checked lane plays in it)
constexpr int kBlocks = (int)(kFrames / kBlock);
constexpr long kRamp = 441;  // Mixer::kGainRampSec at 44.1 kHz

struct Env {
    ResolvedEvents ev;
    std::vector<nlohmann::json> insts;
    std::set<std::string> instNames;
};

std::vector<float> pullAll(Mixer& m) {
    std::vector<float> out((size_t)kFrames * 2);
    AudioBuffer block(2, kBlock);
    for (int b = 0; b < kBlocks; ++b) {
        m.pullBlock(block, kBlock);
        for (int i = 0; i < kBlock; ++i) {
            out[((size_t)b * kBlock + i) * 2] = block.getReadPointer(0)[i];
            out[((size_t)b * kBlock + i) * 2 + 1] = block.getReadPointer(1)[i];
        }
    }
    return out;
}
} // namespace

int main() {
    const fs::path dir = LANES_GENRE_DIR;
    Env env;
    std::vector<std::string> instStrings;
    std::vector<fs::path> paths;
    for (const auto& e : fs::directory_iterator(dir)) {
        const auto n = e.path().filename().string();
        if (n.rfind("inst-", 0) == 0 && e.path().extension() == ".json") paths.push_back(e.path());
    }
    std::sort(paths.begin(), paths.end(), [](const fs::path& a, const fs::path& b) {
        return std::stoi(a.stem().string().substr(5)) < std::stoi(b.stem().string().substr(5));
    });
    for (const auto& p : paths) {
        instStrings.push_back(readFile(p));
        env.insts.push_back(nlohmann::json::parse(instStrings.back()));
        env.instNames.insert(env.insts.back().at("name").get<std::string>());
    }
    env.ev = Resolver().resolve(readFile(dir / "song.json"), instStrings);
    const mix::MixConfig cfg = mix::MixConfig::fromFile(LANES_MIX_CONFIG);

    StubSamples stubs{stub(1), stub(2), stub(3), stub(4), stub(5)};
    auto make = [&](bool mixOn) {
        auto m = std::make_unique<Mixer>(44100.0, kBlock, 2.5, stubs);
        if (mixOn) { m->setMixEnabled(true); m->setMixConfig(cfg); }
        m->enableMeters(kBin);
        m->build(env.ev, env.insts);
        return m;
    };

    // (1) lane names
    auto full = make(false);
    std::set<std::string> seen;
    for (int i = 0; i < full->laneCount(); ++i) {
        const std::string& nm = full->laneName(i);
        check(seen.insert(nm).second, "duplicate lane " + nm);
        check(env.instNames.count(nm) || nm == "Sample Transitions FX", "lane name not an instrument: " + nm);
    }
    check(seen.count("Drums") && seen.count("Guitar") && seen.count("Bass"), "Drums/Guitar/Bass lanes missing");

    // (2) meters == solo master (mix off)
    pullAll(*full);
    const int fullBins = (int)(kFrames / kBin);
    for (const std::string want : {"Drums", "Bass", "Guitar"}) {
        int lane = -1;
        for (int i = 0; i < full->laneCount(); ++i) if (full->laneName(i) == want) lane = i;
        auto solo = make(false);
        for (int i = 0; i < solo->laneCount(); ++i) if (i != lane) solo->setLaneGain(i, 0.0f);
        const std::vector<float> master = pullAll(*solo);
        double worst = 0.0, energy = 0.0;
        for (int b = 1; b < fullBins; ++b) {  // bin 0 holds the others' 10 ms fade-out
            float pk = 0.0f; double ss = 0.0;
            for (long f = (long)b * kBin; f < (long)(b + 1) * kBin; ++f) {
                const float L = master[(size_t)f * 2], R = master[(size_t)f * 2 + 1];
                pk = std::max(pk, std::max(std::fabs(L), std::fabs(R)));
                ss += (double)L * L + (double)R * R;
            }
            const double rms = std::sqrt(ss / (2.0 * kBin));
            worst = std::max(worst, (double)std::fabs(pk - full->lanePeaks(lane)[b]));
            worst = std::max(worst, std::fabs(rms - full->laneRms(lane)[b]));
            energy += rms;
        }
        check(energy > 1.0, want + ": solo render is silent (test not exercising the lane)");
        check(worst < 1e-5, want + ": meters differ from the solo render by " + std::to_string(worst));
        std::printf("lanes_test: %s meters vs solo render: max diff %.2e\n", want.c_str(), worst);
    }

    // (3a) all muted (mix off) -> master exactly 0 after the ramp
    {
        auto m = make(false);
        for (int i = 0; i < m->laneCount(); ++i) m->setLaneGain(i, 0.0f);
        const std::vector<float> master = pullAll(*m);
        float tail = 0.0f;
        for (size_t i = (size_t)kRamp * 2; i < master.size(); ++i) tail = std::max(tail, std::fabs(master[i]));
        check(tail == 0.0f, "all lanes at gain 0 should give silence, peak " + std::to_string(tail));
    }
    // (3b) mix on: muting Drums zeroes its meters and changes the master
    {
        auto on = make(true);
        const std::vector<float> ref = pullAll(*on);
        auto muted = make(true);
        int lane = -1;
        for (int i = 0; i < muted->laneCount(); ++i) if (muted->laneName(i) == "Drums") lane = i;
        muted->setLaneGain(lane, 0.0f);
        const std::vector<float> got = pullAll(*muted);
        float pk = 0.0f;
        for (int b = 1; b < fullBins; ++b) pk = std::max(pk, muted->lanePeaks(lane)[b]);
        check(pk == 0.0f, "muted Drums lane should meter 0 after the ramp");
        double d = 0.0, sig = 0.0;
        for (size_t i = 0; i < ref.size(); ++i) { d += (ref[i] - got[i]) * (ref[i] - got[i]); sig += ref[i] * ref[i]; }
        check(std::sqrt(d / sig) > 0.1, "muting Drums with the mix on should change the master");
        float onPk = 0.0f;
        for (int b = 1; b < fullBins; ++b) onPk = std::max(onPk, on->lanePeaks(lane)[b]);
        check(onPk > 0.01f, "unmuted Drums lane should meter signal with the mix on");
    }

    // (4) Pro mode: laneOverrides in the mix config == the same values set live, and
    // they change what they should. Bass at -6 dB meters half the standard level.
    {
        nlohmann::json pro = nlohmann::json::parse(readFile(LANES_MIX_CONFIG));
        pro["laneOverrides"] = {{"Bass", {{"volumeDb", -6.0}, {"reverb", -12.0}}}};
        int busSlot = -1;
        for (auto& rc : pro["rackChains"])
            if (rc["bus"] == "bass" && rc["plugins"].size() > 1 && !rc["plugins"][1]["params"].empty()) {
                busSlot = 1;
                rc["plugins"][1]["params"][0] = 0.9;
            }
        check(busSlot == 1, "test needs a bass bus plugin with a parameter at slot 1");
        const mix::MixConfig proCfg = mix::MixConfig::fromJson(pro);
        auto fromCfg = std::make_unique<Mixer>(44100.0, kBlock, 2.5, stubs);
        fromCfg->setMixEnabled(true);
        fromCfg->setMixConfig(proCfg);
        fromCfg->enableMeters(kBin);
        fromCfg->build(env.ev, env.insts);
        const std::vector<float> a = pullAll(*fromCfg);

        auto live = make(true);
        int bass = -1;
        for (int i = 0; i < live->laneCount(); ++i) if (live->laneName(i) == "Bass") bass = i;
        live->setLaneTrimDb(bass, -6.0f);
        live->setLaneSendDb(bass, 0, -12.0f);
        live->setBusParam("bass", 1, 0, 0.9f);
        live->setLaneGain(bass, 0.0f);   // mute then unmute: the trim must survive
        live->setLaneGain(bass, 1.0f);
        const std::vector<float> b = pullAll(*live);
        double d = 0.0, sig = 0.0;
        // From 2 s on: the live values ramp in over 10 ms, and the compressors on the
        // bass bus remember that first moment for a while.
        for (size_t i = (size_t)2 * 44100 * 2; i < a.size(); ++i) { d += (a[i] - b[i]) * (a[i] - b[i]); sig += a[i] * a[i]; }
        check(std::sqrt(d / sig) < 1e-4, "Pro values set live should equal the same laneOverrides, rel diff " + std::to_string(std::sqrt(d / sig)));

        auto std0 = make(true);
        pullAll(*std0);
        double ratio = 0.0; int n = 0;
        for (int bn = 2; bn < fullBins; ++bn) {
            const float s0 = std0->laneRms(bass)[bn];
            if (s0 > 1e-3f) { ratio += fromCfg->laneRms(bass)[bn] / s0; ++n; }
        }
        check(n > 10, "Bass should play in the test window");
        const double avg = ratio / std::max(1, n);
        check(std::fabs(avg - mix::dbToGain(-6.0)) < 0.01, "Bass at -6 dB should meter x0.501, got x" + std::to_string(avg));
        std::printf("lanes_test: Pro mode live vs config rel diff %.2e, Bass -6 dB level x%.3f\n", std::sqrt(d / sig), avg);

        bool threw = false;
        try { nlohmann::json bad = pro; bad["laneOverrides"]["Bass"]["pan"] = 0; mix::MixConfig::fromJson(bad); }
        catch (const std::exception&) { threw = true; }
        check(threw, "an unknown laneOverrides field must be refused");
    }

    if (failures == 0) std::printf("lanes_test: OK\n");
    else std::printf("lanes_test: %d FAILURE(S)\n", failures);
    return failures == 0 ? 0 : 1;
}
