// transitionPattern (the EDM snare roll, legacy TransitionPattern.h) resolution
// and mix. A minimal two-segment song with one transitionPattern instrument and
// one arrangement[seg].transitions block:
//   1. the roll resolves to ONE step track named after the instrument, one clip
//      at segStart + sequenceStartPosition/8 beats + offset seconds, barsCount*4
//      beats long, with the exact hits (channel = pattern key ORDER, not
//      alphabetical; hits past the first channel's 32*barsCount steps dropped);
//   2. channel c is samples[c] at getMidiNoteNumber(note);
//   3. with the mix on the lane reports target volume - 12 dB (Sequencer.cpp
//      edmSnareDrumRoll track volume) in the drums fxGroup, and its metered peak
//      is exactly that much (plus the step-velocity difference) below mix off;
//   4. a block missing a required field throws, naming it.
#include "../src/Resolver.h"
#include "../src/audio/MixTables.h"
#include "../src/audio/Mixer.h"
#include "../vendor/json.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

using namespace casperaki;

namespace {
int failures = 0;
void check(bool cond, const std::string& msg) {
    if (!cond) { std::printf("FAIL: %s\n", msg.c_str()); ++failures; }
}

std::shared_ptr<SampleData> stub(int role) {
    auto d = std::make_shared<SampleData>();
    const int frames = 4000, pad = 8192;
    d->audio.setSize(1, frames + pad);
    float* x = d->audio.getWritePointer(0);
    const double f0 = 80 + role * 37;
    for (int i = 0; i < frames; ++i)
        x[i] = (float)((1.0 - (double)i / frames) * 0.6 * std::sin(2 * M_PI * f0 * i / 44100.0));
    d->frames = frames;
    d->sampleRate = 44100;
    return d;
}

const char* kRollName = "edmSnareDrumRoll__drop";

// Keys deliberately out of alphabetical order ("zeta" before "alpha"): the
// channel index follows the JSON object's key order. "zeta" (32 steps -> 1 bar)
// hits steps 0 and 31; "alpha" hits step 4 (an upper-case X, with grid
// separators) and step 33, past the clip's 32 steps, which setNote drops.
std::string songJson(const std::string& block) {
    return std::string(R"({
  "genre": "edm", "tempo": 120,
  "structure": [
    {"segment": "intro", "bars": ["C","C"]},
    {"segment": "drop",  "bars": ["C","C","C","C"]}
  ],
  "arrangement": {
    "drop": {
      "instruments": {"edmSnareDrumRoll__drop": true},
      "transitions": {"edmSnareDrumRoll__drop": )") + block + R"(}
    }
  }
})";
}

const std::string kBlock = R"({
  "id": 7, "sequenceStartPosition": 64, "sequenceStartPositionOffsetInSeconds": 0.25,
  "config": {"details": {"lengthInBars": 1, "pattern": {
    "zeta":  "x0000000 00000000 00000000 0000000x",
    "alpha": "0000X000|00000000|00000000|00000000|0x"
  }}}
})";

const std::string kInst = R"({
  "id": 7, "name": "edmSnareDrumRoll__drop", "shortName": "edmSnareRoll",
  "type": "transitionPattern", "lowLevelType": "snareDrumsElectronic",
  "sampleOrVst": "twoSamples", "isSample": true, "isVst": false,
  "samples": [{"note": "C1", "id": 501}, {"note": "G1", "id": 502}]
})";

float lanePeak(Mixer& m, int lane) {
    AudioBuffer block(2, 128);
    while (m.pullBlock(block, 128)) {}
    float pk = 0.0f;
    for (int b = 0; b < m.meterBinCount(); ++b) pk = std::max(pk, m.lanePeaks(lane)[b]);
    return pk;
}
} // namespace

int main() {
    const std::vector<std::string> instStrings{kInst};
    const ResolvedEvents ev = Resolver().resolve(songJson(kBlock), instStrings);

    // (1)+(2) resolution
    const Track* roll = nullptr;
    for (const auto& t : ev.tracks)
        if (t.name == kRollName) roll = &t;
    check(ev.tracks.size() == 1, "exactly one track (got " + std::to_string(ev.tracks.size()) + ")");
    check(roll != nullptr, "roll track named after the instrument");
    if (roll) {
        check(roll->clips.size() == 1, "one clip");
        const Clip& c = roll->clips.at(0);
        check(c.type == "step" && c.name == "drop", "step clip named after the segment");
        // drop starts at beat 8; +64/8 = 8 beats -> beat 16 = 8.0 s; +0.25 s offset.
        check(std::fabs(c.startSec - 8.25) < 1e-12, "startSec 8.25 (got " + std::to_string(c.startSec) + ")");
        check(std::fabs(c.endSec - 10.25) < 1e-12, "endSec 10.25 = start + 1 bar (got " + std::to_string(c.endSec) + ")");
        check(c.channels.size() == 2 && c.channels[0].n == 24 && c.channels[0].name == "C1"
                  && c.channels[1].n == 31 && c.channels[1].name == "G1",
              "channels = samples[] order: (24,C1), (31,G1)");
        check(c.patterns.size() == 1 && c.patterns[0].numSteps == 32, "one pattern of 32 steps");
        if (c.patterns.size() == 1) {
            std::vector<std::array<int, 3>> got;
            for (const auto& h : c.patterns[0].hits) got.push_back({h.ch, h.step, h.vel});
            const std::vector<std::array<int, 3>> want{{0, 0, 127}, {0, 31, 127}, {1, 4, 127}};
            check(got == want, "hits = zeta(ch0) steps 0,31 + alpha(ch1) step 4, vel 127");
        }
    }

    // (3) mix: the -12 dB trim on top of the target volume, drums fxGroup.
    const std::vector<nlohmann::json> insts{nlohmann::json::parse(kInst)};
    StubSamples stubs{stub(1), stub(2), stub(3), stub(4), stub(5)};
    auto make = [&](bool mixOn) {
        auto m = std::make_unique<Mixer>(44100.0, 128, 1.0, stubs);
        if (mixOn) m->setMixEnabled(true);
        m->enableMeters(1024);
        m->build(ev, insts);
        return m;
    };
    auto on = make(true);
    auto off = make(false);
    check(on->laneCount() == 1 && on->laneName(0) == kRollName, "one lane, named after the instrument");
    const double target = mix::getInstrumentTargetVolume("snareDrumsElectronic", "edm");
    const auto info = nlohmann::json::parse(on->laneInfoJson());
    bool found = false;
    for (const auto& l : info.at("lanes")) {
        if (l.at("lane") != kRollName) continue;
        found = true;
        check(std::fabs(l.at("volumeDb").get<double>() - (target - 12.0)) < 1e-9,
              "lane volumeDb = target - 12 (got " + l.at("volumeDb").dump() + ")");
        check(l.at("fxGroup") == "drums", "fxGroup drums (got " + l.at("fxGroup").dump() + ")");
    }
    check(found, "roll lane in laneInfoJson");

    // Mix off: gain 0 dB, velocity 0.75. Mix on: gain target-12 dB, velocity
    // 127/127 x 96/127. The sampler applies gainDb - 20(1 - vel).
    const double vOn = 96.0 / 127.0;
    const double wantDb = (target - 12.0 - 20.0 * (1.0 - vOn)) - (-20.0 * (1.0 - 0.75));
    const float pkOn = lanePeak(*on, 0), pkOff = lanePeak(*off, 0);
    check(pkOff > 0.0f, "roll lane is not silent (mix off)");
    const double gotDb = 20.0 * std::log10((double)pkOn / (double)pkOff);
    check(std::fabs(gotDb - wantDb) < 0.01,
          "mix-on/off peak ratio " + std::to_string(gotDb) + " dB, want " + std::to_string(wantDb));

    // (4) a missing required field throws, naming it.
    std::string noOffset = kBlock;
    noOffset.replace(noOffset.find("\"sequenceStartPositionOffsetInSeconds\": 0.25,"),
                     std::string("\"sequenceStartPositionOffsetInSeconds\": 0.25,").size(), "");
    bool threw = false;
    try { Resolver().resolve(songJson(noOffset), instStrings); }
    catch (const std::runtime_error& e) {
        threw = std::string(e.what()).find("sequenceStartPositionOffsetInSeconds") != std::string::npos;
    }
    check(threw, "missing sequenceStartPositionOffsetInSeconds throws naming the field");

    if (failures == 0) std::printf("transition_pattern_test: OK\n");
    return failures == 0 ? 0 : 1;
}
