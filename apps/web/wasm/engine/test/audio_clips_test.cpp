// audioClips instruments (sung vocal takes; docs/superpowers/specs/2026-11-24-sung-vocals-design.md §5):
//   1. the resolver turns each clip into a one-shot wave clip on a track named after the instrument, from its
//      section's start, as long as the clip;
//   2. the sample library registers each clip's audio under its key from its sourcePath (an absolute path);
//   3. rendered with the mix on, the lane sounds while the clip plays and is silent after it.
// Uses the latin envelope (as lanes_test) plus one audioClips inst whose clip is a generated 2 s sine WAV.
#include "../src/Resolver.h"
#include "../src/audio/MixConfig.h"
#include "../src/audio/Mixer.h"
#include "../src/audio/SampleLibrary.h"
#include "../vendor/json.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
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

// 16-bit stereo 44.1 kHz sine WAV of `sec` seconds.
void writeSineWav(const fs::path& p, double sec) {
    const int rate = 44100, ch = 2;
    const uint32_t n = (uint32_t)std::llround(sec * rate);
    std::ofstream f(p, std::ios::binary);
    auto u32 = [&](uint32_t v) { f.write(reinterpret_cast<const char*>(&v), 4); };
    auto u16 = [&](uint16_t v) { f.write(reinterpret_cast<const char*>(&v), 2); };
    f.write("RIFF", 4); u32(36 + n * ch * 2); f.write("WAVE", 4);
    f.write("fmt ", 4); u32(16); u16(1); u16(ch); u32(rate); u32(rate * ch * 2); u16(ch * 2); u16(16);
    f.write("data", 4); u32(n * ch * 2);
    for (uint32_t i = 0; i < n; ++i) {
        const int16_t s = (int16_t)std::lround(0.4 * 32767 * std::sin(2 * M_PI * 330.0 * i / rate));
        u16((uint16_t)s); u16((uint16_t)s);
    }
}

std::shared_ptr<SampleData> stub() {
    auto d = std::make_shared<SampleData>();
    d->audio.setSize(1, 8192 + 100);
    d->frames = 100;
    d->sampleRate = 44100;
    return d;
}
} // namespace

int main() {
    const fs::path dir = AUDIO_CLIPS_GENRE_DIR;
    const fs::path tmp = fs::temp_directory_path() / "casperaki-audio-clips-test";
    fs::create_directories(tmp);
    const fs::path take = tmp / "take.wav";
    writeSineWav(take, 2.0);

    std::vector<std::string> instStrings;
    std::vector<fs::path> paths;
    for (const auto& e : fs::directory_iterator(dir)) {
        const auto n = e.path().filename().string();
        if (n.rfind("inst-", 0) == 0 && e.path().extension() == ".json") paths.push_back(e.path());
    }
    std::sort(paths.begin(), paths.end());
    for (const auto& p : paths) instStrings.push_back(readFile(p));
    const std::string songText = readFile(dir / "song.json");
    const nlohmann::json song = nlohmann::json::parse(songText);
    const std::string firstSeg = song.at("structure").at(0).at("segment").get<std::string>();
    const nlohmann::json clipsInst = {
        {"id", 60000}, {"name", "Vocal"}, {"type", "audioClips"}, {"lowLevelType", "vocalsLaSinger"},
        {"clips", nlohmann::json::array({{{"segment", firstSeg}, {"key", "take-x.wav"}, {"sourcePath", take.string()}, {"durationSec", 2.0}}})},
    };
    instStrings.push_back(clipsInst.dump());

    // (1) resolution
    ResolvedEvents ev = Resolver().resolve(songText, instStrings);
    const Track* vocal = nullptr;
    for (const auto& t : ev.tracks) if (t.name == "Vocal") vocal = &t;
    check(vocal != nullptr, "a track named Vocal");
    if (vocal) {
        check(vocal->clips.size() == 1, "one clip");
        const Clip& c = vocal->clips.front();
        check(c.type == "wave" && !c.loop && c.source == "take-x.wav", "a one-shot wave clip keyed by the take");
        check(std::abs(c.startSec - 0.0) < 1e-9 && std::abs(c.endSec - 2.0) < 1e-9, "from the section start, 2 s long");
    }

    // (2) the library registers the clip audio under its key (absolute sourcePath)
    const fs::path genreDir = tmp / "genre";
    fs::create_directories(genreDir);
    { std::ofstream(genreDir / "asset-manifest.json") << "{}"; }
    std::vector<nlohmann::json> instJsons = {clipsInst};
    ResolvedEvents only;
    only.lengthSec = ev.lengthSec;
    only.secPerBeat = ev.secPerBeat;
    if (vocal) only.tracks.push_back(*vocal);

    StubSamples stubs{stub(), stub(), stub(), stub(), stub()};
    const mix::MixConfig cfg = mix::MixConfig::fromFile(AUDIO_CLIPS_MIX_CONFIG);  // the mixer keeps a pointer
    // Peak during the clip and after it (the mix adds the vocal group's reverb/delay tail, so "ends" is checked dry).
    auto render = [&](bool mixOn, int& sources) {
        Mixer m(44100.0, 128, 0.5, stubs);
        if (mixOn) { m.setMixEnabled(true); m.setMixConfig(cfg); }
        SampleLibrary lib("/");
        sources = lib.loadInto(m, genreDir, instJsons).waveSources;
        m.build(only, instJsons);
        AudioBuffer block(2, 128);
        double inClip = 0, after = 0;
        long pos = 0;
        while (pos < (long)(4.0 * 44100)) {
            m.pullBlock(block, 128);
            for (int i = 0; i < 128; ++i, ++pos) {
                const double x = std::abs(block.getReadPointer(0)[i]);
                if (pos > 4410 && pos < 2 * 44100 - 4410) inClip = std::max(inClip, x);
                if (pos > (long)(2.1 * 44100)) after = std::max(after, x);
            }
        }
        return std::pair<double, double>{inClip, after};
    };
    int sources = 0;
    const auto dry = render(false, sources);
    check(sources == 1, "one wave source registered, got " + std::to_string(sources));
    check(dry.first > 0.1, "the Vocal lane sounds during the clip (dry peak " + std::to_string(dry.first) + ")");
    check(dry.second < 1e-6, "the clip ends with its length (dry peak after " + std::to_string(dry.second) + ")");
    // (3) with the mix on: the lane routes through the vocals group (vocalsLaSinger) and sounds.
    const auto wet = render(true, sources);
    check(wet.first > 0.01, "the Vocal lane sounds with the mix on (peak " + std::to_string(wet.first) + ")");

    // (4) a missing take is an error, never a silent render without the vocal
    {
        nlohmann::json bad = clipsInst;
        bad["clips"][0]["sourcePath"] = (tmp / "no-such-take.wav").string();
        std::vector<nlohmann::json> badInsts = {bad};
        Mixer m(44100.0, 128, 0.5, stubs);
        SampleLibrary lib("/");
        bool threw = false;
        try { lib.loadInto(m, genreDir, badInsts); } catch (const std::exception& e) {
            threw = std::string(e.what()).find("no-such-take.wav") != std::string::npos;
        }
        check(threw, "a missing take file throws, naming it");
    }

    // (5) per-lane sends: an instrument's fxSends object replaces the table sends for its lane only
    if (vocal) {
        nlohmann::json wetInst = clipsInst;
        wetInst["id"] = 60001;
        wetInst["name"] = "Vocal wet";
        wetInst["fxSends"] = {{"reverb", -10}, {"delay", -18}, {"chorus", -100}};
        ResolvedEvents two = only;
        Track wetTrack = *vocal;
        wetTrack.name = "Vocal wet";
        two.tracks.push_back(wetTrack);
        std::vector<nlohmann::json> twoInsts = {clipsInst, wetInst};
        auto sendsOf = [&](const std::vector<nlohmann::json>& insts, const ResolvedEvents& ev2) {
            Mixer m(44100.0, 128, 0.5, stubs);
            m.setMixEnabled(true);
            m.setMixConfig(cfg);
            SampleLibrary lib("/");
            lib.loadInto(m, genreDir, insts);
            m.build(ev2, insts);
            return nlohmann::json::parse(m.laneInfoJson());
        };
        const auto info = sendsOf(twoInsts, two);
        const nlohmann::json* dryLane = nullptr;
        const nlohmann::json* wetLane = nullptr;
        for (const auto& l : info.at("lanes")) {
            if (l.at("track") == "Vocal") dryLane = &l;
            if (l.at("track") == "Vocal wet") wetLane = &l;
        }
        check(dryLane && wetLane, "both Vocal lanes exist");
        if (dryLane && wetLane) {
            const auto& w = wetLane->at("sendsDb");
            check(w.at("reverb") == -10 && w.at("delay") == -18 && w.at("chorus") == -100,
                  "the wet lane uses its fxSends: " + w.dump());
            const mix::FxSends t = cfg.laneSends(dryLane->at("fxGroup").get<std::string>(), "vocalsLaSinger", info.at("genre").get<std::string>());
            const auto& d = dryLane->at("sendsDb");
            check(d.at("reverb") == t.reverb && d.at("delay") == t.delay && d.at("chorus") == t.chorus,
                  "the lane without fxSends keeps the table sends: " + d.dump());
        }
        // Pro mode never touches a take lane's sends (spec "Mix"): song overrides and live setLaneSendDb
        {
            nlohmann::json pj = nlohmann::json::parse(readFile(AUDIO_CLIPS_MIX_CONFIG));
            pj["laneOverrides"]["Vocal"] = {{"reverb", -3}, {"delay", -3}, {"chorus", -3}};
            pj["laneOverrides"]["Vocal wet"] = {{"reverb", -3}, {"delay", -3}, {"chorus", -3}};
            const mix::MixConfig proCfg = mix::MixConfig::fromJson(pj);
            nlohmann::json dryInst = clipsInst;
            dryInst["fxSends"] = {{"reverb", -100}, {"delay", -100}, {"chorus", -100}};
            std::vector<nlohmann::json> proInsts = {dryInst, wetInst};
            Mixer m(44100.0, 128, 0.5, stubs);
            m.setMixEnabled(true);
            m.setMixConfig(proCfg);
            SampleLibrary lib("/");
            lib.loadInto(m, genreDir, proInsts);
            m.build(two, proInsts);
            for (int li = 0; li < m.laneCount(); ++li)
                for (int bus = 0; bus < 3; ++bus) m.setLaneSendDb(li, bus, -1.0f);
            const auto pinfo = nlohmann::json::parse(m.laneInfoJson());
            int seen = 0;
            for (const auto& l : pinfo.at("lanes")) {
                const auto& sd = l.at("sendsDb");
                if (l.at("track") == "Vocal") {
                    ++seen;
                    check(sd.at("reverb") == -100 && sd.at("delay") == -100 && sd.at("chorus") == -100,
                          "the dry take lane keeps -100 sends under Pro overrides: " + sd.dump());
                }
                if (l.at("track") == "Vocal wet") {
                    ++seen;
                    check(sd.at("reverb") == -10 && sd.at("delay") == -18 && sd.at("chorus") == -100,
                          "the wet take lane keeps its sends under Pro overrides: " + sd.dump());
                }
            }
            check(seen == 2, "both take lanes seen under Pro overrides");
        }
        // a partial fxSends object throws, naming the lane and the key
        nlohmann::json partial = wetInst;
        partial["fxSends"] = {{"reverb", -10}, {"delay", -18}};
        bool threw = false;
        ResolvedEvents wetOnly = only;
        wetOnly.tracks.clear();
        wetOnly.tracks.push_back(wetTrack);
        try { sendsOf({partial}, wetOnly); } catch (const std::exception& e) {
            const std::string msg = e.what();
            threw = msg.find("Vocal wet") != std::string::npos && msg.find("chorus") != std::string::npos;
        }
        check(threw, "an fxSends object missing a key throws, naming the lane and the key");
    }

    fs::remove_all(tmp);
    if (failures == 0) std::printf("PASS audio_clips_test\n");
    return failures == 0 ? 0 : 1;
}
