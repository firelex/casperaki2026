// Phase 2 Scope B — the mix/FX routing graph (docs/63 §1). Reimplements the
// Sequencer.cpp Tracktion routing as data: per-lane dry -> per-fxGroup submix
// (each running its AirWindows rack) -> the MASTER track's rack; plus 3 aux sends
// -> 3 aux returns (reverb/delay/chorus racks). The returns bypass the master rack:
// legacy inserts the return tracks without routing them (Sequencer.cpp:220-226), so
// Tracktion sends them to the edit master, which only has the -1 dB volume.
// Optional final stage (docs/67 #1): the legacy production mastering, +5 dB into
// NC-17 (Louder 0, Output 0.89) — Matchering.h JUST_BOOST_AND_LIMIT.
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

#include <algorithm>
#include <cmath>
#include <stdexcept>
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
// Level probe around one plugin of a rack (for the device views): peak and
// sum of squares of the signal going in and coming out, accumulated until read.
struct Probe {
    static constexpr int kRing = 4096;  // samples of mono (L+R)/2 kept for the spectrum view
    int slot = -1;              // config index of the probed plugin; -1 = off
    float inPeak = 0.0f, outPeak = 0.0f;
    double inSq = 0.0, outSq = 0.0;
    long frames = 0;
    float inRing[kRing] = {}, outRing[kRing] = {};
    int ringPos = 0;            // next write index (shared by both rings)
    void reset() { inPeak = outPeak = 0.0f; inSq = outSq = 0.0; frames = 0; }
};

inline void ringWrite(float* ring, int pos, float* const ch[2], int n) {
    for (int i = 0; i < n; ++i) ring[(pos + i) % Probe::kRing] = 0.5f * (ch[0][i] + ch[1][i]);
}

inline void measure(float* const ch[2], int n, float& peak, double& sq) {
    for (int c = 0; c < 2; ++c)
        for (int i = 0; i < n; ++i) {
            const float v = ch[c][i];
            peak = std::max(peak, std::fabs(v));
            sq += (double)v * v;
        }
}

struct Rack {
    std::vector<std::unique_ptr<aw::Plugin>> plugins;
    std::vector<int> configIndex;   // each plugin's position in the mix config's chain
    Probe probe;
    void process(AudioBuffer& buf, int n) {
        float* ch[2] = { buf.getWritePointer(0), buf.getWritePointer(1) };
        for (size_t i = 0; i < plugins.size(); ++i) {
            const bool probed = probe.slot >= 0 && configIndex[i] == probe.slot;
            if (probed) {
                measure(ch, n, probe.inPeak, probe.inSq);
                ringWrite(probe.inRing, probe.ringPos, ch, n);
            }
            plugins[i]->process(ch, ch, n);
            if (probed) {
                measure(ch, n, probe.outPeak, probe.outSq);
                ringWrite(probe.outRing, probe.ringPos, ch, n);
                probe.ringPos = (probe.ringPos + n) % Probe::kRing;
                probe.frames += n;
            }
        }
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
        for (size_t i = 0; i < rd.plugins.size(); ++i) {
            const auto& pd = rd.plugins[i];
            if (noEq && pd.factory == "makeEQ") continue;
            if (auto p = makeAwByFactory(pd.factory, sr, pd.params)) {
                r.plugins.push_back(std::move(p));
                r.configIndex.push_back((int)i);
            }
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
        // Built last so the racks above draw the same rand() dither seeds as before.
        mastering_ = aw::makeNC17();
        mastering_->setSampleRate(sr_);
        mastering_->setParam(0, 0.0f);    // Louder: 0 dB (Casperaki_NC17::setParams(0.0, 0.89))
        mastering_->setParam(1, 0.89f);   // Output
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

    // The legacy production mastering stage on the final output (default off).
    void setMastering(bool on) { masteringOn_ = on; }
    bool mastering() const { return masteringOn_; }

    // Run every rack and sum to `out` (cleared first): submixes -> master rack;
    // returns (after their racks) join AFTER the master rack; then the -1 dB master
    // volume; then, when on, the mastering stage.
    void render(AudioBuffer& out, int n) {
        for (auto& kv : submixes_) {
            kv.second.rack.process(kv.second.buf, n);
            addInto(master_.buf, kv.second.buf, 1.0f, n);
        }
        master_.rack.process(master_.buf, n);
        for (auto& r : returns_) {
            r.rack.process(r.buf, n);
            addInto(master_.buf, r.buf, 1.0f, n);
        }
        const float mv = mix::dbToGain(cfg_ ? cfg_->masterVolumeDb() : mix::kMasterVolumeDb);
        out.clear();
        for (int ch = 0; ch < 2; ++ch) {
            const float* s = master_.buf.getReadPointer(ch);
            float* d = out.getWritePointer(ch);
            for (int i = 0; i < n; ++i) d[i] = s[i] * mv;
        }
        if (masteringOn_) {
            const float boost = mix::dbToGain(kMasteringBoostDb);
            float* ch[2] = { out.getWritePointer(0), out.getWritePointer(1) };
            for (int c = 0; c < 2; ++c)
                for (int i = 0; i < n; ++i) ch[c][i] *= boost;
            mastering_->process(ch, ch, n);
        }
    }

    static constexpr float kMasteringBoostDb = 5.0f;   // Matchering.h:1713

    // Probe the plugin at config index `slot` of `bus` ("master", a return bus
    // "fxPlateReverb"/"fxStereoDelay"/"fxChorus", or an fxGroup submix); every
    // other probe is turned off. slot < 0 turns probing off. Allocation-free.
    void setProbe(const std::string& bus, int slot) {
        Rack* target = nullptr;
        auto visit = [&](const std::string& name, Rack& r) {
            r.probe.slot = -1;
            r.probe.reset();
            if (name == bus) target = &r;
        };
        visit("master", master_.rack);
        visit("fxPlateReverb", returns_[0].rack);
        visit("fxStereoDelay", returns_[1].rack);
        visit("fxChorus", returns_[2].rack);
        for (auto& kv : submixes_) visit(kv.first, kv.second.rack);
        if (slot < 0) return;
        if (!target) throw std::out_of_range("MixGraph::setProbe: no bus '" + bus + "' in this mix");
        if (std::find(target->configIndex.begin(), target->configIndex.end(), slot) == target->configIndex.end())
            throw std::out_of_range("MixGraph::setProbe: bus '" + bus + "' has no plugin at slot " + std::to_string(slot));
        target->probe.slot = slot;
        probed_ = target;
    }
    // Set parameter `index` (raw AirWindows 0..1) of the plugin at config index
    // `slot` of `bus`, live (the plugins read their parameters every block).
    // Allocation-free; call between renders.
    void setParam(const std::string& bus, int slot, int index, float value) {
        Rack* target = nullptr;
        if (bus == "master") target = &master_.rack;
        else if (bus == "fxPlateReverb") target = &returns_[0].rack;
        else if (bus == "fxStereoDelay") target = &returns_[1].rack;
        else if (bus == "fxChorus") target = &returns_[2].rack;
        else {
            auto it = submixes_.find(bus);
            if (it != submixes_.end()) target = &it->second.rack;
        }
        if (!target) throw std::out_of_range("MixGraph::setParam: no bus '" + bus + "' in this mix");
        for (size_t i = 0; i < target->plugins.size(); ++i) {
            if (target->configIndex[i] != slot) continue;
            if (index < 0 || index >= target->plugins[i]->numParams())
                throw std::out_of_range("MixGraph::setParam: plugin " + std::to_string(slot) + " of '" + bus + "' has no parameter " + std::to_string(index));
            if (!(value >= 0.0f && value <= 1.0f))
                throw std::out_of_range("MixGraph::setParam: value must be in 0..1");
            target->plugins[i]->setParam(index, value);
            return;
        }
        throw std::out_of_range("MixGraph::setParam: bus '" + bus + "' has no plugin at slot " + std::to_string(slot));
    }

    // Read and reset the probe: in peak, in RMS, out peak, out RMS, frames measured.
    void readProbe(float out[5]) {
        if (!probed_ || probed_->probe.slot < 0) throw std::logic_error("MixGraph::readProbe: no probe set");
        Probe& p = probed_->probe;
        const double n = p.frames > 0 ? 2.0 * (double)p.frames : 1.0;
        out[0] = p.inPeak;
        out[1] = (float)std::sqrt(p.inSq / n);
        out[2] = p.outPeak;
        out[3] = (float)std::sqrt(p.outSq / n);
        out[4] = (float)p.frames;
        p.reset();
    }

    // The probe's sample rings (newest sample just before ringPos), for spectra.
    const Probe& probe() const {
        if (!probed_ || probed_->probe.slot < 0) throw std::logic_error("MixGraph::probe: no probe set");
        return probed_->probe;
    }

    // A return bus's signal after its rack, valid after render() for this block
    // (0 = reverb, 1 = delay, 2 = chorus): for the mixer's bus meters.
    const AudioBuffer& returnBuffer(int k) const { return returns_[k].buf; }

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
    Rack* probed_ = nullptr;
    Bus returns_[3];
    Bus master_;
    std::unique_ptr<aw::Plugin> mastering_;   // NC-17, built with the racks
    bool masteringOn_ = false;
};

} // namespace casperaki
