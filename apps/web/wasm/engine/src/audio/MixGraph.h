// Phase 2 Scope B — the mix/FX routing graph (docs/63 §1). Reimplements the
// Sequencer.cpp Tracktion routing as data: per-lane dry -> per-fxGroup submix
// (each running its AirWindows rack) -> master; plus 3 aux sends -> 3 aux returns
// (reverb/delay/chorus racks) -> master; master runs its rack + the -1 dB volume.
//
// Driven per block by the Mixer (gated behind mixEnabled): for each lane it adds
// the lane's rendered audio to its fxGroup submix (dry) and, scaled, to the 3 aux
// sends; then render() runs every rack and sums to the output. Racks come from
// RackData.h (the decoded PresetManager chains) via the factory dispatch below.
//
// An absent rack (fxGroup with no RackData entry) is a pass-through, so the graph
// degrades gracefully. SimpleSide / ValhallaFreqEcho are passthrough placeholders
// (BespokeFx.cpp) until reimplemented.
#pragma once

#include "AudioBuffer.h"
#include "MixTables.h"
#include "MixConfig.h"   // runtime rack chains + master volume (docs/64)
#include "airwindows/AwPlugins.h"
#include "airwindows/AwRand.h"

#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

namespace casperaki {

// factory-name (RackData) -> a configured aw::Plugin (sample rate + decoded params).
inline std::unique_ptr<aw::Plugin> makeAwByFactory(const std::string& f, double sr,
                                                   const std::vector<float>& params) {
    using namespace aw;
    std::unique_ptr<Plugin> p;
    if (f == "makeConsole8SubIn") p = makeConsole8SubIn();
    else if (f == "makeConsole8SubOut") p = makeConsole8SubOut();
    else if (f == "makeConsole8BussIn") p = makeConsole8BussIn();
    else if (f == "makeConsole8BussOut") p = makeConsole8BussOut();
    else if (f == "makeAir2") p = makeAir2();
    else if (f == "makeHuge") p = makeHuge();
    else if (f == "makeStereoChorus") p = makeStereoChorus();
    else if (f == "makeTexturizeMS") p = makeTexturizeMS();
    else if (f == "makeKPlateA") p = makeKPlateA();
    else if (f == "makeKPlateD") p = makeKPlateD();
    else if (f == "makePyewacket") p = makePyewacket();
    else if (f == "makeEQ") p = makeEQ();
    else if (f == "makeLogical4") p = makeLogical4();
    else if (f == "makeNC17") p = makeNC17();
    else if (f == "makeThunder") p = makeThunder();
    else if (f == "makeADClip7") p = makeADClip7();
    else if (f == "makeTapeDelay") p = makeTapeDelay();
    else if (f == "makeSimpleSide") p = makeSimpleSide();
    else if (f == "makeFreqShiftEcho") p = makeFreqShiftEcho();
    else if (f == "makeValhallaFreqEcho") p = makeValhallaFreqEcho();
    if (!p) return p;
    p->setSampleRate(sr);
    for (int i = 0; i < (int)params.size() && i < p->numParams(); ++i) p->setParam(i, params[(size_t)i]);
    return p;
}

// An ordered AirWindows plugin chain processed in place on a stereo buffer.
struct Rack {
    std::vector<std::unique_ptr<aw::Plugin>> plugins;
    void process(AudioBuffer& buf, int n) {
        float* ch[2] = { buf.getWritePointer(0), buf.getWritePointer(1) };
        for (auto& p : plugins) p->process(ch, ch, n);
    }
    void setTransport(double spb, double t) { for (auto& p : plugins) p->setTransport(spb, t); }
    void seek(long long songSample) { for (auto& p : plugins) p->seek(songSample); }
    bool empty() const { return plugins.empty(); }
};

// cfg drives the chains when provided (runtime JSON); else the compiled-in
// mix::rackChains() (RackData.h) is the fallback for the no-config path.
inline Rack buildRack(const mix::MixConfig* cfg, const std::string& bus, double sr) {
    Rack r;
    const bool noEq = std::getenv("CASPERAKI_NO_EQ") != nullptr;  // DEBUG: skip EQ to measure its effect
    const auto& chains = cfg ? cfg->rackChains() : mix::rackChains();
    for (const auto& rd : chains) {
        if (rd.bus != bus) continue;
        for (const auto& pd : rd.plugins) {
            if (noEq && pd.factory == "makeEQ") continue;
            if (auto p = makeAwByFactory(pd.factory, sr, pd.params)) r.plugins.push_back(std::move(p));
        }
        break;
    }
    return r;
}

class MixGraph {
public:
    MixGraph(double sr, int blockSize) : sr_(sr), block_(blockSize) {
        master_.buf.setSize(2, blockSize);
        for (int k = 0; k < 3; ++k) returns_[k].buf.setSize(2, blockSize);
    }

    // Build the master + the 3 aux-return racks, and one submix per present fxGroup.
    void build(const mix::MixConfig* cfg, const std::set<std::string>& fxGroups) {
        cfg_ = cfg;
        // The plugins seed their noise from rand() as they are constructed below:
        // start from the fresh-process state so every build is the same.
        aw::seedPortableRand(1);
        master_.rack = buildRack(cfg, "master", sr_);
        returns_[0].rack = buildRack(cfg, "fxPlateReverb", sr_);   // bus 0
        returns_[1].rack = buildRack(cfg, "fxStereoDelay", sr_);   // bus 1
        returns_[2].rack = buildRack(cfg, "fxChorus", sr_);        // bus 2
        submixes_.clear();
        for (const auto& g : fxGroups) {
            Bus b;
            b.rack = buildRack(cfg, g, sr_);
            b.buf.setSize(2, block_);
            submixes_.emplace(g, std::move(b));
        }
    }

    void clear() {
        master_.buf.clear();
        for (auto& r : returns_) r.buf.clear();
        for (auto& kv : submixes_) kv.second.buf.clear();
    }

    // Per-block transport for tempo-synced FX (SimpleSide). timeSec = song time at
    // the block start; secPerBeat = 60/bpm.
    void setTransport(double secPerBeat, double timeSec) {
        master_.rack.setTransport(secPerBeat, timeSec);
        for (auto& r : returns_) r.rack.setTransport(secPerBeat, timeSec);
        for (auto& kv : submixes_) kv.second.rack.setTransport(secPerBeat, timeSec);
    }

    // A play-position jump: every rack's position-derived state (LFO phases)
    // follows to `songSample` (see aw::Plugin::seek).
    void seek(long long songSample) {
        master_.rack.seek(songSample);
        for (auto& r : returns_) r.rack.seek(songSample);
        for (auto& kv : submixes_) kv.second.rack.seek(songSample);
    }

    // Add a lane's rendered audio to its fxGroup submix (dry).
    void addDry(const std::string& fxGroup, const AudioBuffer& lane, int n) {
        auto it = submixes_.find(fxGroup);
        Bus& b = (it != submixes_.end()) ? it->second : ensureSubmix(fxGroup);
        addInto(b.buf, lane, 1.0f, n);
    }

    // Add a lane's audio, scaled, to aux send bus k (0=reverb,1=delay,2=chorus).
    void addSend(int k, const AudioBuffer& lane, float gain, int n) {
        if (k < 0 || k >= 3 || gain <= 0.0f) return;
        addInto(returns_[k].buf, lane, gain, n);
    }

    // Run every rack and sum to `out` (cleared first): submixes -> master,
    // returns -> master, master rack, then the -1 dB master volume.
    void render(AudioBuffer& out, int n) {
        for (auto& kv : submixes_) {
            kv.second.rack.process(kv.second.buf, n);
            addInto(master_.buf, kv.second.buf, 1.0f, n);
        }
        for (auto& r : returns_) {
            r.rack.process(r.buf, n);
            addInto(master_.buf, r.buf, 1.0f, n);
        }
        master_.rack.process(master_.buf, n);
        const float mv = mix::dbToGain(cfg_ ? cfg_->masterVolumeDb() : mix::kMasterVolumeDb);
        out.clear();
        for (int ch = 0; ch < 2; ++ch) {
            const float* s = master_.buf.getReadPointer(ch);
            float* d = out.getWritePointer(ch);
            for (int i = 0; i < n; ++i) d[i] = s[i] * mv;
        }
    }

private:
    struct Bus { Rack rack; AudioBuffer buf; };

    Bus& ensureSubmix(const std::string& g) {
        Bus b; b.rack = buildRack(cfg_, g, sr_); b.buf.setSize(2, block_);
        return submixes_.emplace(g, std::move(b)).first->second;
    }

    static void addInto(AudioBuffer& dst, const AudioBuffer& src, float g, int n) {
        for (int ch = 0; ch < 2; ++ch) {
            const float* s = src.getReadPointer(ch);
            float* d = dst.getWritePointer(ch);
            if (g == 1.0f) for (int i = 0; i < n; ++i) d[i] += s[i];
            else           for (int i = 0; i < n; ++i) d[i] += g * s[i];
        }
    }

    double sr_;
    int block_;
    const mix::MixConfig* cfg_ = nullptr;   // rack chains + master volume (set in build)
    std::map<std::string, Bus> submixes_;
    Bus returns_[3];
    Bus master_;
};

} // namespace casperaki
