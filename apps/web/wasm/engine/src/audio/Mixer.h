// Streaming mixer core (docs/60 Phase 1 step 6 — real-time playback). The
// reusable, RT-shaped half of the render: it holds N per-track Samplers + the
// track->sampler JOIN, and renders one fixed-size block at a time via pullBlock.
// The AudioWorklet drives it (pull one 128-frame quantum per process() call) and
// the offline casperaki_render becomes a thin loop over pullBlock — so the SAME
// mix code serves the browser and the WAV oracle.
//
// Deliberately INDEPENDENT of OggDecode (no stb_vorbis): the mixer consumes
// already-decoded PCM (a StubSamples set + an id-keyed real-sample registry),
// so the browser path can feed decodeAudioData buffers and never compile the
// native-only codec. OggDecode stays in Render.h (the native adapter).
//
// Real-sample join (docs/60 Phase 1 finish): the mixer keys decoded PCM by a
// string id and binds it during build(). The keys are taken straight from the
// IR + inst-N.json (never the asset-manifest — the host owns that):
//   - tonal/bass zone     -> the inst.samples[] slot id (decimal), e.g. "945"
//                            (the host has already SLICED [sliceStart,sliceEnd])
//   - drum step channel   -> the sub-instrument name, e.g. "bassDrum1"
//   - wave/loop clip       -> the resolved source, e.g. "playsample-50000.ogg"
// Whoever owns the codec (OggDecode/minimp3 natively, decodeAudioData in the
// browser) decodes, slices and pushes the PCM via setSample(key, data). A key
// with no registered PCM (no library, unresolved slot, or a deferred lane like
// guitar strums/fret-noises) falls back to the role stub — so the no-library
// path is byte-for-byte unchanged (the parity guard + offline WAV both rely on
// that: they never register a real sample, so every join lands on a stub).
//
// Bit-identical to the previous track-outer Render.h: sources are appended in
// the SAME order the old renderTrack visited them (per track: wave, then midi,
// then step), each source ADDS into the shared block accumulator in that order,
// and each Sampler keeps its own per-source scratch so the cross-voice ADSR
// quirk (a later voice's envelope scales earlier voices in the SHARED track
// buffer) is preserved per source per block. Same 128-frame block boundaries +
// same per-sample accumulation order => same float arithmetic.
//
// Carries the docs/57f lesson: the loop is PULL-BASED (the caller asks for the
// next block); the mixer never drives itself in an offline busy-loop.
#pragma once

#include "../ResolvedEvents.h"
#include "../Random.h"
#include "../music/Note.h"
#include "../../vendor/json.hpp"
#include "AudioBuffer.h"
#include "LowPass.h"
#include "MixGraph.h"
#include "MixTables.h"
#include "Sampler.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <cstdlib>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace casperaki {

// The five role-keyed stub fixtures the no-library join maps every logical sound
// onto (mirrors prestage-samples.mjs). Already-decoded PCM, supplied by whoever
// owns the codec: OggDecode on the native side, decodeAudioData on the web side.
struct StubSamples {
    std::shared_ptr<SampleData> kick, snare, hat, tone, bass;
};

class Mixer {
public:
    Mixer(double sampleRate, int blockSize, double tailSec, const StubSamples& stubs)
        : sampleRate_(sampleRate), blockSize_(blockSize), tailSec_(tailSec), stubs_(stubs) {}

    // Streaming master gain for the RT path (no look-ahead, so no peak-normalise).
    // Left at 1.0 for the offline path, whose end-of-song peakNormalize divides it
    // back out anyway — so offline output is unchanged whatever this is set to.
    void setMasterGain(float g) { masterGain_ = g; }

    // Phase 2 Scope A: enable the per-instrument-group mix (per-lane VolumeAndPan
    // levels from FX::getInstrumentTargetVolume; drums per sub-instrument). GATED —
    // default OFF, so the no-mix render stays BYTE-IDENTICAL to the Phase-1 path
    // (every gainDb 0 / wave gain 1.0). Call before build(). Routing/aux-sends/FX
    // (Scope B/C) layer on later behind their own host-owned data.
    void setMixEnabled(bool e) { mixEnabled_ = e; }
    bool mixEnabled() const { return mixEnabled_; }

    // docs/67 #1 — the legacy production mastering stage (+5 dB into NC-17) on the
    // final output. Needs the mix (graph) on. May be called before or after build().
    void setMastering(bool on) {
        mastering_ = on;
        if (graph_) graph_->setMastering(on);
    }
    bool mastering() const { return mastering_; }

    // docs/64 — the runtime mix/FX config (volumes/sends/fxGroups/racks loaded from
    // mix-config.json). Call before build(). When unset, the per-lane lookups fall
    // back to the compiled-in MixTables.h/RackData.h (identical values — the parity
    // gate proves it — so the no-config path is byte-identical).
    void setMixConfig(const mix::MixConfig& c) { mixCfg_ = &c; }

    // Register already-decoded (and, for tonal lanes, already-sliced) PCM under a
    // string key the join looks up (see the header comment for the key scheme).
    // Call BEFORE build() — the join binds the data into its sources there. The
    // host owns the codec; the mixer just stores the shared buffer.
    void setSample(const std::string& key, std::shared_ptr<SampleData> data) {
        samplesById_[key] = std::move(data);
    }
    bool hasRealSamples() const { return !samplesById_.empty(); }

    // The PCM registered under `key`, or nullptr if absent (for tests/inspection).
    std::shared_ptr<SampleData> sampleById(const std::string& key) const {
        auto it = samplesById_.find(key);
        return it != samplesById_.end() ? it->second : nullptr;
    }

    long totalFrames() const { return totalFrames_; }
    double sampleRate() const { return sampleRate_; }

    // Build the per-track sources from the resolved IR + the inst-N.json configs.
    void build(const ResolvedEvents& ev, const std::vector<nlohmann::json>& instJsons) {
        indexInstruments(instJsons);
        genre_ = ev.genre;
        totalFrames_ = (long)std::ceil((ev.lengthSec + tailSec_) * sampleRate_);
        secPerBeat_ = ev.secPerBeat;
        lanes_.clear();
        graph_.reset();
        pos_ = 0;
        seekScratch_.setSize(2, blockSize_);

        for (const auto& track : ev.tracks)
            buildTrack(track);

        // docs/62 A7 — one self-contained transitionNoise lane per riser. The
        // source carries its own dB envelope + LP cutoff sweep + base gain, so it
        // works in BOTH the flat and graph paths (and is byte-neutral for songs
        // with no riser — ev.noiseRises is then empty). fxGroup "fx" matches
        // mix::getFxGroup("fxNoiseRise") so the graph path routes it through the
        // transition FX submix (legacy parity).
        buildNoiseRiseLanes(ev);

        // One instrument lane per instrument name (the track names' baseName:
        // "Drums-kicks"/"-snares"/... -> "Drums", "Guitar(strums)" -> "Guitar"),
        // in first-track order. Lane gain + meters work on these groups.
        laneScratch_.setSize(2, blockSize_);
        groups_.clear();
        for (auto& l : lanes_) {
            const std::string nm = baseName(l.name);
            int gi = -1;
            for (int k = 0; k < (int)groups_.size(); ++k)
                if (groups_[(size_t)k].name == nm) { gi = k; break; }
            if (gi < 0) {
                gi = (int)groups_.size();
                groups_.emplace_back();
                groups_.back().name = nm;
            }
            l.group = gi;
        }
        gainRampFrames_ = std::max(1, (int)std::lround(kGainRampSec * sampleRate_));
        if (meterBinFrames_ > 0) allocateMeters();

        // Scope B: build the routing graph (submix per present fxGroup + the 3 aux
        // returns + master). Gated — only when the host opted into the mix/FX.
        if (mixEnabled_) {
            // Scope D: attach each instrument's signalProcessors automation to every
            // lane whose baseName matches (drums -> its 4 step tracks, etc.).
            for (const auto& a : ev.automation)
                for (auto& l : lanes_)
                    if (baseName(l.name) == a.instName) {
                        l.lpAuto = a.lowPass;
                        l.volAuto = a.volume;
                        if (!l.lpAuto.empty()) l.lp = std::make_unique<LowPass>(sampleRate_);
                    }
            std::set<std::string> groups;
            for (const auto& l : lanes_) if (!l.fxGroup.empty()) groups.insert(l.fxGroup);
            graph_ = std::make_unique<MixGraph>(sampleRate_, blockSize_);
            graph_->build(mixCfg_, groups);
            graph_->setMastering(mastering_);
        }
        if (mastering_ && !graph_)
            throw std::logic_error("Mixer: mastering needs the mix on (setMixEnabled(true) before build)");
    }

    // Render the next `numFrames` (<= blockSize) into `out`, advancing the play
    // position. `out` is cleared internally, then every source ADDS into it in
    // append order. Returns true while audio remains (pos < totalFrames).
    bool pullBlock(AudioBuffer& out, int numFrames) {
        out.clear();
        const long n = std::min((long)numFrames, std::max(0L, totalFrames_ - pos_));
        if (n <= 0) { pos_ += numFrames; return false; }

        const bool metering = meterBinFrames_ > 0 && !meterSuspended_;
        if (metering)
            for (auto& g : groups_) g.sum.clear();

        if (graph_) {
            // Scope B graph path: render each lane to its own buffer, route the dry
            // signal to its fxGroup submix + the 3 aux sends, then run the submix /
            // return / master racks and sum to `out` (master volume applied inside).
            graph_->clear();
            graph_->setTransport(secPerBeat_, (double)pos_ / sampleRate_);  // for SimpleSide pump
            const double blockTimeSec = (double)pos_ / sampleRate_;
            for (auto& lane : lanes_) {
                if (!soloMatch(lane)) continue;   // DEBUG: CASPERAKI_SOLO lane/fxGroup filter
                laneScratch_.clear();
                for (auto& s : lane.sources) s->addBlock(pos_, (int)n, laneScratch_);
                applyLaneAutomation(lane, blockTimeSec, (int)n);
                Group& g = groups_[(size_t)lane.group];
                g.ramp.apply(laneScratch_, (int)n);           // mute/solo gain (pre-sends)
                if (metering) addInto(g.sum, laneScratch_, (int)n);
                graph_->addDry(lane.fxGroup, laneScratch_, (int)n);
                for (int k = 0; k < 3; ++k) graph_->addSend(k, laneScratch_, lane.sendGain[k], (int)n);
                for (auto& s : lane.sources) s->addAuxSends(pos_, (int)n, laneScratch_, *graph_, g.ramp);
            }
            graph_->render(out, (int)n);
            applyMasterGain(out, (int)n);
        } else if (!metering && allGainsUnity()) {
            // Flat path (mix disabled): every lane's sources add into `out` in the
            // old append order -> byte-identical to Phase 1.
            for (auto& lane : lanes_) {
                if (!soloMatch(lane)) continue;   // DEBUG: CASPERAKI_SOLO lane/fxGroup filter
                for (auto& s : lane.sources)
                    s->addBlock(pos_, (int)n, out);
            }
            applyMasterGain(out, (int)n);
        } else {
            // Flat path with a lane gain or meters: each lane renders to its own
            // buffer first (same signal; float summation grouping differs by ULPs).
            for (auto& lane : lanes_) {
                if (!soloMatch(lane)) continue;   // DEBUG: CASPERAKI_SOLO lane/fxGroup filter
                laneScratch_.clear();
                for (auto& s : lane.sources) s->addBlock(pos_, (int)n, laneScratch_);
                Group& g = groups_[(size_t)lane.group];
                g.ramp.apply(laneScratch_, (int)n);
                if (metering) addInto(g.sum, laneScratch_, (int)n);
                addInto(out, laneScratch_, (int)n);
            }
            applyMasterGain(out, (int)n);
        }
        if (metering) {
            for (auto& g : groups_) meterGroup(g, (int)n);
            if (graph_)
                for (int k = 0; k < 3; ++k) meterBusPeak(busPeak_[(size_t)k], graph_->returnBuffer(k), (int)n);
            meterBusPeak(busPeak_[3], out, (int)n);
        }
        for (auto& g : groups_) g.ramp.advance((int)n);
        pos_ += numFrames;
        return pos_ < totalFrames_;
    }

    // The play position (frames from song start) the next pullBlock renders from.
    long position() const { return pos_; }

    // ---- instrument lanes (sequencer rows) ---------------------------------
    // One lane per instrument name, in track order (valid after build()). The
    // shared transition track + noise risers form the "Sample Transitions FX" lane.
    int laneCount() const { return (int)groups_.size(); }

    // The mix as resolved, for the mixer view and debugging: one entry per IR
    // track (several per instrument lane for drums), JSON:
    //   {"lanes":[{"lane":<instrument lane>,"track":<IR track>,"lowLevelType":..,
    //     "fxGroup":..,"volumeDb":<n|null>,"sendsDb":{"reverb":..,"delay":..,"chorus":..},
    //     "lowPass"?:{"t0":s,"step":s,"values":[Hz..]}, "volume"?:{"t0":s,"step":s,"values":[dB..]}}],
    //    "mixEnabled":bool,"genre":..}
    // The returned reference stays valid until the next call.
    const std::string& laneInfoJson() {
        nlohmann::json out;
        out["mixEnabled"] = mixEnabled_;
        out["genre"] = genre_;
        out["lanes"] = nlohmann::json::array();
        auto num = [](double v) { return std::isfinite(v) ? nlohmann::json(v) : nlohmann::json(nullptr); };
        for (const auto& lane : lanes_) {
            nlohmann::json l;
            l["lane"] = lane.group >= 0 ? groups_[(size_t)lane.group].name : std::string();
            l["track"] = lane.name;
            l["lowLevelType"] = lane.lowLevelType;
            l["fxGroup"] = lane.fxGroup;
            l["volumeDb"] = num(lane.volumeDb);
            l["sendsDb"] = {{"reverb", num(lane.sendDb[0])}, {"delay", num(lane.sendDb[1])}, {"chorus", num(lane.sendDb[2])}};
            // Automation as the engine applies it, sampled every 50 ms over its range:
            // low-pass cutoff (Hz) and volume (dB). Absent when the lane has none.
            const double step = 0.05;
            auto sampled = [&](const std::vector<AutoPoint>& pts, bool isVolume) {
                nlohmann::json j;
                const double t0 = pts.front().tSec, t1 = pts.back().tSec;
                j["t0"] = t0;
                j["step"] = step;
                nlohmann::json vals = nlohmann::json::array();
                for (double t = t0; t <= t1 + 1e-9; t += step) {
                    if (isVolume) {
                        const float g = evalVolumeGain(pts, t);
                        vals.push_back(g > 1e-9f ? 20.0 * std::log10((double)g) : -120.0);
                    } else {
                        vals.push_back(evalCurve(pts, t, 30000.0));
                    }
                }
                j["values"] = std::move(vals);
                return j;
            };
            if (!lane.lpAuto.empty()) l["lowPass"] = sampled(lane.lpAuto, false);
            if (!lane.volAuto.empty()) l["volume"] = sampled(lane.volAuto, true);
            out["lanes"].push_back(std::move(l));
        }
        laneInfo_ = out.dump();
        return laneInfo_;
    }
    const std::string& laneName(int lane) const { return group(lane).name; }

    // Live lane gain (mute = 0, solo = 0 on the others). Takes effect on the next
    // pull as a linear ramp over kGainRampSec (no click). Allocation-free; call
    // between pulls. Applied to the lane's signal before its submix and aux sends.
    // Set a lane's gain at once, without the ramp (offline renders, e.g. a stem
    // render that must not let other lanes leak in at the start).
    void setLaneGainNow(int lane, float gain) {
        if (!(gain >= 0.0f) || !std::isfinite(gain))
            throw std::out_of_range("Mixer::setLaneGainNow: gain must be finite and >= 0");
        group(lane).ramp.setNow(gain);
    }

    void setLaneGain(int lane, float gain) {
        if (!(gain >= 0.0f) || !std::isfinite(gain))
            throw std::out_of_range("Mixer::setLaneGain: gain must be finite and >= 0");
        group(lane).ramp.setTarget(gain, gainRampFrames_);
    }

    // Level meters: every pull records, per lane and per bin of `binFrames`
    // frames of song time, the peak |sample| (max over L/R) and the RMS (over
    // L+R) of the lane's own signal — after its gain and automation, BEFORE its
    // fxGroup submix rack, the aux returns and the master (those are shared by
    // several lanes). Arrays are allocated here (or in build) from totalFrames,
    // so pulls never allocate. Meant for one straight pull pass: re-pulling a
    // span adds to its RMS (seek pre-roll is not metered). Call before or after
    // build (before allocating the live instance's L/R views).
    void enableMeters(int binFrames) {
        if (binFrames <= 0) throw std::out_of_range("Mixer::enableMeters: binFrames must be > 0");
        meterBinFrames_ = binFrames;
        if (!groups_.empty() || totalFrames_ > 0) allocateMeters();
    }
    int meterBinCount() const { return meterBins_; }
    const float* lanePeaks(int lane) const { requireMeters(); return group(lane).peak.data(); }
    const float* laneRms(int lane) const { requireMeters(); return group(lane).rms.data(); }
    // Device-view probe around one rack plugin (see MixGraph::setProbe/readProbe).
    void setProbe(const std::string& bus, int slot) {
        if (!graph_) throw std::logic_error("Mixer::setProbe: the mix is off (no racks to probe)");
        graph_->setProbe(bus, slot);
    }
    const Probe& probe() const {
        if (!graph_) throw std::logic_error("Mixer::probe: the mix is off");
        return graph_->probe();
    }
    void readProbe(float out[5]) {
        if (!graph_) throw std::logic_error("Mixer::readProbe: the mix is off");
        graph_->readProbe(out);
    }

    // Peak per meter bin of a bus: 0 reverb, 1 delay, 2 chorus return (after
    // their racks), 3 master (the final output). Returns stay 0 without the mix.
    static constexpr int kMeteredBuses = 4;
    const float* busPeaks(int bus) const {
        requireMeters();
        if (bus < 0 || bus >= kMeteredBuses)
            throw std::out_of_range("Mixer::busPeaks: bus " + std::to_string(bus) + " outside [0, 4)");
        return busPeak_[(size_t)bus].data();
    }

    // Move the play position so the next pullBlock continues from `frame`.
    // Allocation-free (safe between real-time pulls). State is rebuilt as a full
    // render from 0 would have it at the seek point:
    //   - sampler lanes: every voice whose note started before the point and is
    //     still sounding there is recreated mid-sample (exact resampler phase);
    //     already-released notes are dropped (only their ~100-sample stop fade
    //     would remain); the event cursor skips to the first event at/after it.
    //   - noise risers: RNG, envelope and filter replayed up to the point (exact).
    //   - wave clips: stateless (position-addressed).
    //   - FX LFO / oscillator phases (chorus sweep, frequency-shifter phase):
    //     set from the song position (aw::Plugin::seek).
    // The FX racks (reverb/delay tails, compressors) and the automation low-pass
    // carry memory that cannot be rebuilt directly, so the state is rebuilt at
    // `frame - prerollFrames` and the remaining span is rendered silently: the
    // racks then hold the real tail of the preceding `prerollFrames` of music.
    // Use prerollFrames = 0 for an instant seek (racks keep their old content).
    void seek(long frame, long prerollFrames) {
        if (frame < 0 || frame > totalFrames_)
            throw std::out_of_range("Mixer::seek: frame " + std::to_string(frame)
                                    + " outside [0, " + std::to_string(totalFrames_) + "]");
        if (prerollFrames < 0)
            throw std::out_of_range("Mixer::seek: negative prerollFrames");
        const long start = std::max(0L, frame - prerollFrames);
        if (graph_) graph_->seek(start);
        for (auto& lane : lanes_) {
            if (lane.lp) lane.lp->reset();
            for (auto& src : lane.sources) src->seek(start, blockSize_);
        }
        pos_ = start;
        meterSuspended_ = true;
        while (pos_ < frame) {
            const int n = (int)std::min((long)blockSize_, frame - pos_);
            pullBlock(seekScratch_, n);
        }
        meterSuspended_ = false;
    }

private:
    // ---- sources ----------------------------------------------------------
    // vel = note velocity 0..1 (native te::SamplerPlugin uses getFloatVelocity =
    // midiVel/127; sampledNoteGains applies gainDb - 20*(1-vel)). Default 0.75 = the
    // legacy no-mix constant (kept when mixEnabled is off for byte-identity).
    struct Event { long sample; bool on; int note; float vel = 0.75f; };

    // A lane's live gain: `gain` now, ramping linearly to `target` over `left`
    // more frames. Unity and settled -> apply() is a no-op (byte-identical).
    struct GainRamp {
        float gain = 1.0f, target = 1.0f, step = 0.0f;
        int left = 0;
        bool unity() const { return left == 0 && gain == 1.0f; }
        float at(int i) const { return i < left ? gain + step * (float)(i + 1) : target; }
        void setNow(float g) { gain = target = g; step = 0.0f; left = 0; }
        void setTarget(float g, int rampFrames) {
            target = g;
            left = rampFrames;
            step = (target - gain) / (float)rampFrames;
        }
        void apply(AudioBuffer& b, int n) const {
            if (unity()) return;
            for (int ch = 0; ch < 2; ++ch) {
                float* d = b.getWritePointer(ch);
                for (int i = 0; i < n; ++i) d[i] *= at(i);
            }
        }
        void advance(int n) {
            if (left == 0) return;
            if (n >= left) { gain = target; left = 0; }
            else { gain += step * (float)n; left -= n; }
        }
    };

    struct Source {
        virtual ~Source() = default;
        // Add this source's contribution for [pos, pos+n) into `out` (already
        // cleared, shared by all sources for the block).
        virtual void addBlock(long pos, int n, AudioBuffer& out) = 0;
        // Optional per-source aux sends. Most sources use the lane-level send; the
        // shared transition wave lane needs per-clip sends while keeping one dry lane.
        virtual void addAuxSends(long, int, AudioBuffer&, MixGraph&, const GainRamp&) {}
        // Rebuild internal state as a render from 0 would have it at `frame`
        // (see Mixer::seek). `blockSize` = the pull grid. Stateless sources: no-op.
        virtual void seek(long /*frame*/, int /*blockSize*/) {}
    };

    // A Sampler fed by a sorted note-on/off event list (midi clips or drum hits).
    struct SamplerSource : Source {
        Sampler sampler;
        std::vector<Event> events;  // sorted by sample
        size_t cursor = 0;
        AudioBuffer scratch;        // own per-source buffer (cross-voice ADSR quirk)

        explicit SamplerSource(double sr, int block) : sampler(sr), scratch(2, block) {}

        void addBlock(long pos, int n, AudioBuffer& out) override {
            // Dispatch this block's events at their intra-block offsets (faithful
            // to the old runSampler: condition is sample < pos + n).
            while (cursor < events.size() && events[cursor].sample < pos + n) {
                const Event& e = events[cursor];
                int off = (int)(e.sample - pos);
                if (off < 0) off = 0;
                if (e.on) sampler.noteOn(e.note, off, e.vel);
                else sampler.noteOff(e.note, off);
                ++cursor;
            }
            // Once events are exhausted and no voices ring, contribute nothing —
            // the old per-source loop `break`ed here (output stays zero either way).
            if (cursor >= events.size() && !sampler.hasActiveVoices()) return;

            scratch.clear();
            sampler.processBlock(scratch, n);
            for (int ch = 0; ch < 2; ++ch) {
                const float* src = scratch.getReadPointer(ch);
                float* dst = out.getWritePointer(ch);
                for (int i = 0; i < n; ++i) dst[i] += src[i];
            }
        }

        void seek(long frame, int /*blockSize*/) override {
            sampler.allVoicesOff();
            // Index of the last event per pitch before `frame`. A note-off AND a
            // later note-on of the same pitch both stop every non-open-ended voice
            // of that pitch, so a note is released if any event of its pitch
            // follows its note-on.
            long lastOff[128];
            for (long& v : lastOff) v = -1;
            size_t i = 0;
            for (; i < events.size() && events[i].sample < frame; ++i) {
                const Event& e = events[i];
                if (e.note < 0 || e.note > 127)
                    throw std::out_of_range("Mixer::seek: MIDI note " + std::to_string(e.note) + " outside 0..127");
                lastOff[e.note] = (long)i;
            }
            cursor = i;
            for (size_t k = 0; k < i; ++k) {
                const Event& e = events[k];
                if (e.on) sampler.restoreNote(e.note, e.vel, frame - e.sample, lastOff[e.note] > (long)k);
            }
        }
    };

    // Wave clips tiled at unity across [start, end). Adds DIRECTLY into the block
    // accumulator (no intermediate buffer) — exactly as the old renderWaveTrack
    // summed into master, so the float grouping is identical even when clips
    // overlap a sample. Each clip carries its OWN decoded source (a real loop /
    // transition sample by id, or the tone stub) so the Sample Transitions FX
    // track — whose clips come from different transition instruments — plays the
    // right sample per clip. In the no-library path every clip's data is the same
    // tone stub, so the per-clip loop is byte-identical to the old single-data one.
    // gain is PER-CLIP: the Loop track's clips share the lane instrument volume, but
    // the shared "Sample Transitions FX" track mixes several transitions with
    // different target volumes, so each clip carries its own gain (1.0 == byte-identical).
    struct WaveClipRT {
        long start, end;
        std::shared_ptr<SampleData> data;
        bool loop;
        float gain = 1.0f;
        std::array<float, 3> sendGain{{0.0f, 0.0f, 0.0f}};
        long loopFrames = 0;   // loop period (frames of `data`); set for every looped clip
    };
    struct WaveSource : Source {
        std::vector<WaveClipRT> clips;

        void addBlock(long pos, int n, AudioBuffer& out) override {
            for (const auto& c : clips) addClipBlock(c, pos, n, out, 1.0f);
        }

        void addAuxSends(long pos, int n, AudioBuffer& scratch, MixGraph& graph,
                         const GainRamp& laneGain) override {
            for (int k = 0; k < 3; ++k) {
                scratch.clear();
                bool hasSend = false;
                for (const auto& c : clips) {
                    const float sg = c.sendGain[(size_t)k];
                    if (sg <= 0.0f) continue;
                    hasSend = true;
                    addClipBlock(c, pos, n, scratch, sg);
                }
                if (hasSend) {
                    laneGain.apply(scratch, n);   // mute/solo reaches the sends too
                    graph.addSend(k, scratch, 1.0f, n);
                }
            }
        }

    private:
        static void addClipBlock(const WaveClipRT& c, long pos, int n, AudioBuffer& out, float gainScale) {
            const long blockEnd = pos + n;
            const SampleData* data = c.data.get();
            if (!data || data->frames <= 0 || gainScale <= 0.0f) return;
            const int srcCh = data->audio.getNumChannels();
            const long lo = std::max(c.start, pos);
            long hi = std::min(c.end, blockEnd);
            if (!c.loop) hi = std::min(hi, c.start + (long)data->frames);
            const float g = c.gain * gainScale;
            for (long i = lo; i < hi; ++i) {
                if (i < 0) continue;
                const long rel = i - c.start;
                const int srcIdx = c.loop ? (int)(rel % c.loopFrames) : (int)rel;
                const int local = (int)(i - pos);
                for (int ch = 0; ch < 2; ++ch) {
                    const float s = data->audio.getReadPointer(std::min(ch, srcCh - 1))[srcIdx];
                    out.getWritePointer(ch)[local] += g * s;  // per-clip; 1.0f -> byte-identical
                }
            }
        }
    };

    // docs/62 A7 — synthesized white-noise riser (fxNoiseRise / legacy
    // TransitionNoise.h). SELF-CONTAINED: unlike the sampler/wave sources (whose
    // gain comes from the lane and whose filter is the shared lpAuto path), this
    // source carries its own dB volume envelope, LP cutoff sweep and base gain.
    // Deterministic: the noise is drawn from a seeded casperaki::Random so the
    // same song renders identical samples every run (the engine's determinism
    // contract). The noise window is contiguous, so the RNG advances exactly once
    // per emitted sample across blocks — no cross-block desync.
    struct NoiseSource : Source {
        long start = 0, end = 0;            // absolute sample window [start, end)
        long attackSamples = 1;             // rise length (samples)
        long decayStartRel = 0, decayEndRel = 0;  // samples-into-clip: decay begin / end
        double freqStart = 100.0, freqEnd = 20000.0;
        double volAttackDb = -30.0, volSustainDb = -20.0, volDecayDb = -50.0;
        float baseGain = 1.0f;              // fxNoiseRise instrument target volume

        NoiseSource(double sr, int64_t seed)
            // Decorrelated L/R streams (the legacy 4OSC runs an independent Gaussian
            // generator per stereo channel — tracktion_Oscillators.cpp:265-286).
            : sr_(sr), lp_(sr), seed_(seed), rngL_(seed), rngR_((seed ^ 0x5DEECE66DLL) & 0xffffffffffffLL) {
            // 4OSC amp envelope = ExpEnvelope (analog), attack/decay 0.1s, sustain
            // 0.8 (tracktion_Envelope.cpp:21-43; preset ampAttack/Decay=0.1,
            // ampSustain=80%). Coeffs depend only on sample rate.
            const double aT = 0.1, dT = 0.1;
            const double attackTCO = std::exp(-0.5), decayTCO = std::exp(-5.0);
            ampAttackCoeff_ = std::exp(-std::log((1.0 + attackTCO) / attackTCO) / (sr_ * aT));
            ampAttackOffset_ = (1.0 + attackTCO) * (1.0 - ampAttackCoeff_);
            ampDecayCoeff_ = std::exp(-std::log((1.0 + decayTCO) / decayTCO) / (sr_ * dT));
            ampDecayOffset_ = (AMP_SUSTAIN - decayTCO) * (1.0 - ampDecayCoeff_);
            // velocityToGain(vel=100/127, ampVelocity=1.0) — tracktion_FourOscPlugin.cpp:396.
            const double v = 100.0 / 127.0;  // sensitivity 1.0 => v == velocity
            velocityGain_ = std::min(1.0, std::max(0.0, v * std::pow(25.0, v) * 0.04));
        }

        void addBlock(long pos, int n, AudioBuffer& out) override {
            const long lo = std::max(start, pos);
            const long hi = std::min(end, pos + n);
            if (lo >= hi) return;
            // te::LowPassPlugin re-reads its cutoff once per block (block-stepped,
            // tracktion_LowPass.cpp:42); its filter is RBJ Butterworth Q=0.707 —
            // identical to LowPass.h, so LowPass.h is the exact LowPassPlugin here.
            lp_.setCutoff(cutoffAt(lo - start));
            for (long i = lo; i < hi; ++i) {
                const long rel = i - start;
                double xL, xR;
                nextFiltered(xL, xR);
                const double volG = volGainAt(rel);           // track volume automation
                const int local = (int)(i - pos);
                // ... then the fader-position volume automation, then the mix-stage
                // fxNoiseRise target volume (baseGain).
                out.getWritePointer(0)[local] += (float)(xL * volG * baseGain);
                out.getWritePointer(1)[local] += (float)(xR * volG * baseGain);
            }
        }

        // Replay the noise state from the riser start up to `frame` on the same
        // block grid a render from 0 uses (the cutoff is re-read once per block).
        void seek(long frame, int blockSize) override {
            rngL_ = casperaki::Random(seed_);
            rngR_ = casperaki::Random((seed_ ^ 0x5DEECE66DLL) & 0xffffffffffffLL);
            spareL_ = spareR_ = 0;
            hasSpareL_ = hasSpareR_ = false;
            ampVal_ = 0;
            ampStage_ = 0;
            lp_.reset();
            const long stop = std::min(frame, end);
            for (long b = (start / blockSize) * blockSize; b < stop; b += blockSize) {
                const long lo = std::max(start, b);
                const long hi = std::min(stop, b + blockSize);
                if (lo >= hi) continue;
                lp_.setCutoff(cutoffAt(lo - start));
                double xL, xR;
                for (long i = lo; i < hi; ++i) nextFiltered(xL, xR);
            }
        }

    private:
        // One sample of the riser before its volume stages: per-channel Gaussian
        // noise (sigma 0.1), osc level + masterLevel = 0 dB (unity), * velocity
        // gain * the 4OSC amp ADSR (shared L/R), then the track LowPassPlugin sweep.
        void nextFiltered(double& xL, double& xR) {
            const double ampE = ampEnvNext();
            const double nL = nextGaussian(rngL_, spareL_, hasSpareL_) * NOISE_SIGMA;
            const double nR = nextGaussian(rngR_, spareR_, hasSpareR_) * NOISE_SIGMA;
            xL = lp_.processSample(0, (float)(nL * velocityGain_ * ampE));
            xR = lp_.processSample(1, (float)(nR * velocityGain_ * ampE));
        }

        // 4OSC noise oscillator: N(0, 0.1) per sample (tracktion_Oscillators.h:81-82).
        static constexpr double NOISE_SIGMA = 0.1;
        static constexpr double AMP_SUSTAIN = 0.8;  // ampSustain 80% (preset)
        static constexpr double PI_ = 3.14159265358979323846;

        // EXACT te::AutomationCurve bezier for the freq sweep's stored curvature 0.5
        // (TransitionNoise.h:76): getBezierPoint doubles+clamps it to c=1.0, placing
        // the quadratic control at (endTime, startFreq); getBezierYFromX then reduces
        // to t = 1 - sqrt(1 - frac), cutoff = freqStart*(1-t^2) + freqEnd*t^2 (the
        // slow-start / fast-finish "exponential" sweep). Held at freqEnd after attack.
        double cutoffAt(long rel) const {
            if (rel <= 0) return freqStart;
            if (rel >= attackSamples) return freqEnd;
            const double frac = (double)rel / (double)attackSamples;
            const double t = 1.0 - std::sqrt(1.0 - frac);
            return freqStart * (1.0 - t * t) + freqEnd * (t * t);
        }

        // Track volume automation, interpolated in FADER-POSITION space then mapped to
        // gain (te::decibelsToVolumeFaderPosition / volumeFaderPositionToGain,
        // tracktion_AudioUtilities.cpp:138-151). Legacy points: -30 dB at start ->
        // -20 dB at attack end (held to decay start) -> -50 dB at decay end.
        double volGainAt(long rel) const {
            const double fpA = dbToFaderPos(volAttackDb);
            const double fpS = dbToFaderPos(volSustainDb);
            const double fpD = dbToFaderPos(volDecayDb);
            double pos;
            if (rel <= 0) pos = fpA;
            else if (rel < attackSamples) pos = fpA + ((double)rel / (double)attackSamples) * (fpS - fpA);
            else if (rel < decayStartRel) pos = fpS;
            else if (rel < decayEndRel) {
                const double u = (double)(rel - decayStartRel) / (double)std::max(1L, decayEndRel - decayStartRel);
                pos = fpS + u * (fpD - fpS);
            } else pos = fpD;
            return faderPosToGain(pos);
        }
        static double dbToFaderPos(double db) {
            return db > -100.0 ? std::exp((db - 6.0) / 20.0) : 0.0;
        }
        static double faderPosToGain(double pos) {
            return pos > 0.0 ? std::pow(10.0, ((20.0 * std::log(pos)) + 6.0) / 20.0) : 0.0;
        }

        // ExpEnvelope (analog ADSR) per-sample recursion (tracktion_Envelope.h:83-136).
        // No release: the held note runs the full clip, which ends with the window.
        double ampEnvNext() {
            if (ampStage_ == 0) {            // attack
                ampVal_ = ampAttackOffset_ + ampVal_ * ampAttackCoeff_;
                if (ampVal_ >= 1.0) { ampVal_ = 1.0; ampStage_ = 1; }
            } else if (ampStage_ == 1) {     // decay
                ampVal_ = ampDecayOffset_ + ampVal_ * ampDecayCoeff_;
                if (ampVal_ <= AMP_SUSTAIN) { ampVal_ = AMP_SUSTAIN; ampStage_ = 2; }
            } else {                         // sustain
                ampVal_ = AMP_SUSTAIN;
            }
            return ampVal_;
        }

        // Gaussian noise via Box-Muller over the engine's deterministic RNG. The
        // legacy std::normal_distribution is implementation-defined (bit-exact is
        // impossible across stdlibs), so we match the DISTRIBUTION (N(0,1)) exactly
        // and stay reproducible run-to-run.
        static double nextUniform(casperaki::Random& r) {
            const uint32_t u = (uint32_t)r.nextInt();
            return ((double)u + 1.0) / 4294967297.0;  // (0,1)
        }
        static double nextGaussian(casperaki::Random& r, double& spare, bool& hasSpare) {
            if (hasSpare) { hasSpare = false; return spare; }
            const double u1 = nextUniform(r), u2 = nextUniform(r);
            const double mag = std::sqrt(-2.0 * std::log(u1));
            spare = mag * std::sin(2.0 * PI_ * u2);
            hasSpare = true;
            return mag * std::cos(2.0 * PI_ * u2);
        }

        double sr_;
        LowPass lp_;
        int64_t seed_;
        casperaki::Random rngL_, rngR_;
        double spareL_ = 0, spareR_ = 0;
        bool hasSpareL_ = false, hasSpareR_ = false;
        double ampAttackCoeff_ = 0, ampAttackOffset_ = 0, ampDecayCoeff_ = 0, ampDecayOffset_ = 0;
        double ampVal_ = 0; int ampStage_ = 0;
        double velocityGain_ = 1.0;
    };

    // A mix lane = one IR track's sources + its routing (fxGroup submix + the 3
    // aux send gains). The disabled path sums every lane's sources flat (byte-
    // identical); the enabled path renders each lane and routes it through the graph.
    std::string laneInfo_;   // laneInfoJson() result (kept for the C string's lifetime)
    std::array<std::vector<float>, 4> busPeak_;   // reverb, delay, chorus returns; master

    struct Lane {
        std::vector<std::unique_ptr<Source>> sources;
        std::string name;       // IR track name (for matching automation by baseName)
        std::string fxGroup;
        float sendGain[3] = {0.0f, 0.0f, 0.0f};  // linear; 0 = no send (Scope B step 2)
        // As resolved, for reporting (laneInfoJson): the lane's lowLevelType, its
        // target volume and its send levels in dB (empty / NaN when not resolved).
        std::string lowLevelType;
        double volumeDb = std::numeric_limits<double>::quiet_NaN();
        double sendDb[3] = {std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::quiet_NaN(),
                            std::numeric_limits<double>::quiet_NaN()};
        // Scope D — per-lane signalProcessors automation (cutoff-Hz / dB curves) +
        // the lowpass instance (allocated only when lpAuto is non-empty).
        std::vector<AutoPoint> lpAuto, volAuto;
        std::unique_ptr<LowPass> lp;
        int group = -1;         // index into groups_ (the instrument lane)
    };

    // An instrument lane (sequencer row): every IR track of one instrument name.
    struct Group {
        std::string name;
        GainRamp ramp;
        AudioBuffer sum;                    // this block's lane signal (meters only)
        std::vector<float> peak, rms;       // per meter bin
        std::vector<double> sumSq;          // per meter bin, L^2 + R^2
    };

    const Group& group(int lane) const {
        if (lane < 0 || lane >= (int)groups_.size())
            throw std::out_of_range("Mixer: lane " + std::to_string(lane) + " outside [0, "
                                    + std::to_string(groups_.size()) + ")");
        return groups_[(size_t)lane];
    }
    Group& group(int lane) { return const_cast<Group&>(static_cast<const Mixer*>(this)->group(lane)); }

    void requireMeters() const {
        if (meterBinFrames_ <= 0 || meterBins_ <= 0)
            throw std::logic_error("Mixer: meters are not enabled (enableMeters) or not built");
    }

    void allocateMeters() {
        meterBins_ = (int)((totalFrames_ + meterBinFrames_ - 1) / meterBinFrames_);
        for (auto& g : groups_) {
            g.sum.setSize(2, blockSize_);
            g.peak.assign((size_t)meterBins_, 0.0f);
            g.rms.assign((size_t)meterBins_, 0.0f);
            g.sumSq.assign((size_t)meterBins_, 0.0);
        }
        for (auto& b : busPeak_) b.assign((size_t)meterBins_, 0.0f);
    }

    // Fold this block of a bus signal into its peak bins.
    void meterBusPeak(std::vector<float>& peaks, const AudioBuffer& buf, int n) {
        const float* L = buf.getReadPointer(0);
        const float* R = buf.getReadPointer(1);
        for (int i = 0; i < n;) {
            const long b = (pos_ + i) / meterBinFrames_;
            if (b >= meterBins_) break;
            const int end = (int)std::min((long)n, (b + 1) * meterBinFrames_ - pos_);
            float pk = peaks[(size_t)b];
            for (int j = i; j < end; ++j) pk = std::max(pk, std::max(std::fabs(L[j]), std::fabs(R[j])));
            peaks[(size_t)b] = pk;
            i = end;
        }
    }

    // Fold this block of a lane's signal (g.sum, frames [pos_, pos_+n)) into its bins.
    void meterGroup(Group& g, int n) {
        const float* L = g.sum.getReadPointer(0);
        const float* R = g.sum.getReadPointer(1);
        int i = 0;
        while (i < n) {
            const long f = pos_ + i;
            const long b = f / meterBinFrames_;
            if (b >= meterBins_) break;
            const int end = (int)std::min((long)n, (b + 1) * meterBinFrames_ - pos_);
            float pk = g.peak[(size_t)b];
            double ss = 0.0;
            for (int j = i; j < end; ++j) {
                const float a = std::fabs(L[j]), c = std::fabs(R[j]);
                pk = std::max(pk, std::max(a, c));
                ss += (double)L[j] * L[j] + (double)R[j] * R[j];
            }
            g.peak[(size_t)b] = pk;
            g.sumSq[(size_t)b] += ss;
            const long binLen = std::min((long)meterBinFrames_, totalFrames_ - b * meterBinFrames_);
            g.rms[(size_t)b] = (float)std::sqrt(g.sumSq[(size_t)b] / (2.0 * (double)binLen));
            i = end;
        }
    }

    bool allGainsUnity() const {
        for (const auto& g : groups_) if (!g.ramp.unity()) return false;
        return true;
    }

    static void addInto(AudioBuffer& dst, const AudioBuffer& src, int n) {
        for (int ch = 0; ch < 2; ++ch) {
            const float* a = src.getReadPointer(ch);
            float* d = dst.getWritePointer(ch);
            for (int i = 0; i < n; ++i) d[i] += a[i];
        }
    }

    // DEBUG (throwaway): CASPERAKI_SOLO=<fxGroup|name-substr> renders only the
    // matching lane(s) through the full graph (others muted) — used to localize a
    // glitch to a specific lane. Empty/unset => all lanes (normal render).
    bool soloMatch(const Lane& lane) const {
        static const char* solo = std::getenv("CASPERAKI_SOLO");
        if (solo == nullptr || *solo == '\0') return true;
        return lane.fxGroup == solo || lane.name.find(solo) != std::string::npos;
    }

    // ---- track -> sources -------------------------------------------------
    void buildTrack(const Track& track) {
        Lane lane;
        lane.name = track.name;
        if (mixEnabled_) {
            lane.fxGroup = laneFxGroup(track);
            // Scope B: the 3 aux send gains (reverb/delay/chorus). bus 0=reverb,
            // 1=delay, 2=chorus — matching FX::Send + MixGraph::returns_.
            lane.lowLevelType = laneLowLevelType(track.name);
            const mix::FxSends sd = cfgLaneSends(lane.fxGroup, lane.lowLevelType);
            lane.sendGain[0] = mix::dbToGain(sd.reverb);
            lane.sendGain[1] = mix::dbToGain(sd.delay);
            lane.sendGain[2] = mix::dbToGain(sd.chorus);
            lane.sendDb[0] = sd.reverb;
            lane.sendDb[1] = sd.delay;
            lane.sendDb[2] = sd.chorus;
            if (!lane.lowLevelType.empty()) lane.volumeDb = cfgTargetVol(lane.lowLevelType);
            if (isTransitionPatternTrack(track.name)) lane.volumeDb += kTransitionPatternTrackDb;
        }
        buildTrackSources(track, lane);
        if (!lane.sources.empty()) lanes_.push_back(std::move(lane));
    }

    // docs/62 A7 — build a self-contained NoiseSource lane per fxNoiseRise riser.
    void buildNoiseRiseLanes(const ResolvedEvents& ev) {
        if (ev.noiseRises.empty()) return;
        const float noiseGain = mix::dbToGain(cfgTargetVol("fxNoiseRise"));
        for (const auto& nr : ev.noiseRises) {
            const long s = (long)std::llround(nr.startSec * sampleRate_);
            const long e =
                (long)std::llround((nr.startSec + nr.decayOffset + nr.decayDuration) * sampleRate_);
            if (e <= s) continue;
            const int64_t seed =
                ((int64_t)s * 2862933555777941757LL + 3037000493LL) & 0xffffffffffffLL;
            auto src = std::make_unique<NoiseSource>(sampleRate_, seed == 0 ? 1 : seed);
            src->start = s;
            src->end = e;
            src->attackSamples = std::max(1L, (long)std::llround(nr.attackDuration * sampleRate_));
            src->decayStartRel = (long)std::llround(nr.decayOffset * sampleRate_);
            src->decayEndRel =
                (long)std::llround((nr.decayOffset + nr.decayDuration) * sampleRate_);
            src->freqStart = nr.freqStart;
            src->freqEnd = nr.freqEnd;
            src->volAttackDb = nr.volAttack;
            src->volSustainDb = nr.volSustain;
            src->volDecayDb = nr.volDecay;
            src->baseGain = noiseGain;
            Lane lane;
            lane.name = "Sample Transitions FX";  // matches no inst automation
            lane.fxGroup = "fx";
            lane.lowLevelType = "fxNoiseRise";
            lane.volumeDb = cfgTargetVol("fxNoiseRise");
            lane.sources.push_back(std::move(src));
            lanes_.push_back(std::move(lane));
        }
    }

    void buildTrackSources(const Track& track, Lane& lane) {
        bool hasMidi = false, hasStepHits = false, hasWave = false, hasStepChannels = false;
        for (const auto& c : track.clips) {
            if (c.type == "midi" && !c.notes.empty()) hasMidi = true;
            else if (c.type == "wave") hasWave = true;
            else if (c.type == "step") {
                if (!c.channels.empty()) hasStepChannels = true;
                for (const auto& p : c.patterns)
                    if (!p.hits.empty()) hasStepHits = true;
            }
        }
        // Append order MUST stay wave -> midi -> step (old renderTrack order) so
        // the per-sample accumulation order is unchanged.
        if (hasWave) buildWaveSource(track, lane);
        if (hasMidi) buildMidiSource(track, lane);
        if (hasStepHits && hasStepChannels) buildStepSource(track, lane);
    }

    void buildWaveSource(const Track& track, Lane& lane) {
        auto src = std::make_unique<WaveSource>();
        // Per-clip mix gain (Phase 2 Scope A). The Loop track's clips share the lane
        // instrument volume (laneLowLevelType). The shared "Sample Transitions FX"
        // track mixes several transitions with DIFFERENT target volumes through one
        // source, so each transition clip carries its own lowLevelType (IR Clip::
        // lowLevel) and gets FX::getInstrumentTargetVolume per clip (cymbalsCrashHit
        // 0 dB, fxLowImpact/fxUplifter -10 dB, ...). Gated: disabled -> gain 1.0
        // (byte-identical no-mix path).
        float laneGain = 1.0f;
        if (mixEnabled_) {
            const std::string llt = laneLowLevelType(track.name);
            if (!llt.empty()) laneGain = mix::dbToGain(cfgTargetVol(llt));
        }
        for (const auto& c : track.clips) {
            if (c.type != "wave") continue;
            const long start = (long)std::lround(c.startSec * sampleRate_);
            long end = (long)std::lround(c.endSec * sampleRate_);
            end = std::min(end, totalFrames_);
            float clipGain = laneGain;
            std::array<float, 3> clipSendGain{{0.0f, 0.0f, 0.0f}};
            if (mixEnabled_ && !c.lowLevel.empty()) {
                // Transition clip. Native (TransitionSample::createSegmentClip)
                // inserts the wave clip at UNITY (no setGain) and applies NO
                // getInstrumentTargetVolume to transitions; the ONLY trim on the
                // path is the -10 dB "Sample Transitions FX" track volume
                // (Sequencer.cpp:208). So every transition (cymbalsCrashHit,
                // fxLowImpact, fxUplifter, ...) plays at unity * -10 dB regardless
                // of its lowLevelType. (Applying getInstrumentTargetVolume here was
                // wrong: it double-attenuated fxLowImpact by 10 dB -> the missing
                // low/tail energy.)
                clipGain = mix::dbToGain(-10.0);
                const std::string clipFxGroup = cfgFxGroup(c.lowLevel);
                const mix::FxSends sd = cfgLaneSends(clipFxGroup, c.lowLevel);
                clipSendGain[0] = mix::dbToGain(sd.reverb);
                clipSendGain[1] = mix::dbToGain(sd.delay);
                clipSendGain[2] = mix::dbToGain(sd.chorus);
            }
            // Real loop/transition sample keyed by the resolved source filename,
            // else the tone stub (old renderWaveTrack — every wave -> tone).
            auto data = realOr(c.source, stubs_.tone);
            long loopFrames = 0;
            if (c.loop) loopFrames = loopPeriodFrames(*data, data == stubs_.tone, c.source);
            src->clips.push_back({start, end, data, c.loop, clipGain, clipSendGain, loopFrames});
        }
        lane.sources.push_back(std::move(src));
    }

    // Loop period of a looped wave clip, as legacy Loop.h:58-67 sets it: the
    // file's length in WHOLE bars at the song tempo (te::BarsAndBeats.bars, rounded
    // down) x 4 beats. The rest of the file (MP3 padding, ~30-40 ms) is never played,
    // so every repeat lands on the bar grid. The tone stub (no real sample) keeps
    // its own length: it is a placeholder, not a bar loop.
    long loopPeriodFrames(const SampleData& d, bool isStub, const std::string& source) const {
        if (isStub) return d.frames;
        const double barSec = 4.0 * secPerBeat_;
        const double fileSec = (double)d.frames / (double)d.sampleRate;
        const long bars = (long)std::floor(fileSec / barSec + 1e-9);
        if (bars < 1)
            throw std::runtime_error("Mixer: loop '" + source + "' is " + std::to_string(fileSec)
                                     + " s, shorter than one bar (" + std::to_string(barSec) + " s) at the song tempo");
        const long frames = (long)std::lround((double)bars * barSec * (double)d.sampleRate);
        return std::min(frames, (long)d.frames);
    }

    void buildMidiSource(const Track& track, Lane& lane) {
        auto src = std::make_unique<SamplerSource>(sampleRate_, blockSize_);
        buildMidiSampler(track, src->sampler);
        if (src->sampler.numSounds() == 0) return;  // old renderMidiTrack early-out

        // Phase 2 Scope A: the per-lane VolumeAndPanPlugin level (tonal/guitar/bass).
        // gainDb adds in dB through sampledNoteGains, so this equals a post-sampler
        // track gain. Gated: when disabled, gainDb stays 0 -> byte-identical.
        if (mixEnabled_)
            src->sampler.setAllSoundGainDb((float)cfgTargetVol(laneLowLevelType(track.name)));

        // MIDI clip -> note events as Tracktion plays them (te::MidiList::
        // exportToPlaybackMidiSequence, tracktion_MidiList.cpp:1950-1985, and
        // MidiNote::getPlaybackTime, :823-833):
        //  - notes starting at/after the clip end, or ending before its start, are skipped;
        //  - a note-off lands at min(note end, clip end) - 0.0001 s, so nothing rings
        //    past its segment;
        //  - a note overlapped by a later note of the same pitch gets NO note-off
        //    (the later note-on cuts it in the sampler instead).
        for (const auto& c : track.clips) {
            if (c.type != "midi") continue;
            std::vector<const Note*> notes;
            for (const auto& nt : c.notes) notes.push_back(&nt);
            std::stable_sort(notes.begin(), notes.end(),
                             [](const Note* a, const Note* b) { return a->startBeat < b->startBeat; });
            const double clipLenBeats = (c.endSec - c.startSec) / secPerBeat_;
            for (size_t i = 0; i < notes.size(); ++i) {
                const Note& nt = *notes[i];
                const double endBeat = nt.startBeat + nt.lenBeats;
                if (nt.startBeat >= clipLenBeats || endBeat <= 0.0) continue;
                bool useNoteUp = true;
                for (size_t j = i + 1; j < notes.size(); ++j) {
                    const double s2 = notes[j]->startBeat;
                    if (s2 >= clipLenBeats || s2 >= endBeat) break;
                    if (notes[j]->n == nt.n) { useNoteUp = false; break; }
                }
                const double onSec = c.startSec + nt.startBeat * secPerBeat_;
                const double offSec = std::min(c.startSec + endBeat * secPerBeat_, c.endSec) - 0.0001;
                const float vel = mixEnabled_ ? (float)nt.vel / 127.0f : 0.75f;
                src->events.push_back({(long)std::lround(onSec * sampleRate_), true, nt.n, vel});
                if (useNoteUp)
                    src->events.push_back({(long)std::lround(offSec * sampleRate_), false, nt.n, vel});
            }
        }
        std::stable_sort(src->events.begin(), src->events.end(),
                         [](const Event& a, const Event& b) { return a.sample < b.sample; });
        lane.sources.push_back(std::move(src));
    }

    void buildStepSource(const Track& track, Lane& lane) {
        std::vector<StepChannel> channels;
        for (const auto& c : track.clips)
            if (c.type == "step" && !c.channels.empty()) { channels = c.channels; break; }
        if (channels.empty()) return;

        // A transitionPattern lane (the EDM snare roll): channel c plays samples[c],
        // joined by its playsample id; see buildTransitionPatternSound.
        const nlohmann::json* rollInst = transitionPatternInst(track.name);

        // Phase 2 Scope A: drums set gain PER SOUND (native setSoundGains), keyed by
        // each sub-instrument's own lowLevelType, not a single track level.
        const nlohmann::json* drumInst = nullptr;
        if (mixEnabled_ && !rollInst) {
            auto it = instByName_.find(baseName(track.name));
            if (it != instByName_.end()) drumInst = it->second;
        }

        auto src = std::make_unique<SamplerSource>(sampleRate_, blockSize_);
        for (const auto& ch : channels) {
            if (rollInst) { src->sampler.addSound(buildTransitionPatternSound(*rollInst, ch)); continue; }
            SamplerSound s;
            // Real one-shot keyed by the sub-instrument name, else the role stub.
            s.data = realOr(ch.name, drumFixtureForName(ch.name));
            s.keyNote = ch.n;
            s.minNote = ch.n;
            s.maxNote = ch.n;
            s.openEnded = true;  // drums are one-shots (setSoundOpenEnded true)
            if (drumInst) s.gainDb = (float)cfgTargetVol(drumSubLowLevelType(*drumInst, ch.name));
            src->sampler.addSound(s);
        }

        for (const auto& c : track.clips) {
            if (c.type != "step") continue;
            for (const auto& p : c.patterns) {
                if (p.numSteps <= 0) continue;
                const double stepDurSec = (c.endSec - c.startSec) / p.numSteps;
                for (const auto& h : p.hits) {
                    if (h.ch < 0 || h.ch >= (int)channels.size()) continue;
                    const double onSec = c.startSec + h.step * stepDurSec;
                    // Tracktion StepClip note-on velocity = step vel/127 x channel vel/127
                    // (tracktion_StepClip.cpp:389-393); legacy never sets the channel
                    // velocity, so it stays at the default 96 (StepClip.h:178) -> -4.9 dB.
                    const float vel = mixEnabled_ ? ((float)h.vel / 127.0f) * kStepChannelVelocity : 0.75f;
                    src->events.push_back({(long)std::lround(onSec * sampleRate_), true,
                                           channels[(size_t)h.ch].n, vel});
                }
            }
        }
        std::stable_sort(src->events.begin(), src->events.end(),
                         [](const Event& a, const Event& b) { return a.sample < b.sample; });
        lane.sources.push_back(std::move(src));
    }

    // The inst-N.json of a transitionPattern track (its name is the instrument
    // name), or nullptr when the track is not one.
    const nlohmann::json* transitionPatternInst(const std::string& trackName) const {
        auto it = instByName_.find(trackName);
        if (it == instByName_.end() || it->second == nullptr) return nullptr;
        const auto& inst = *it->second;
        if (!inst.contains("type") || !inst["type"].is_string()
            || inst["type"].get<std::string>() != "transitionPattern")
            return nullptr;
        return &inst;
    }
    bool isTransitionPatternTrack(const std::string& trackName) const {
        return transitionPatternInst(trackName) != nullptr;
    }

    // One sampler sound of a transitionPattern lane (TransitionPattern.h
    // createSampler: a te::SamplerPlugin sound per sample, open-ended, keyed to
    // its own note). The step channel is named by the sample's note; the PCM is
    // the playsample-<id>.ogg the host staged for that sample (SampleLibrary
    // loadWaves), else the snare stub, as the drum channels fall back.
    //
    // Gain (mix on): FX::getInstrumentTargetVolume(lowLevelType) via
    // applyPreVolumeToTrack (Sequencer.cpp:509-515) plus the -12 dB track volume
    // (Sequencer.cpp:170-177, the Sequencer constructor). Both are post-sampler, so they add in dB to the
    // sound gain. Legacy set that -12 dB only on a track named exactly
    // "edmSnareDrumRoll"; the engine adapter names each roll
    // "edmSnareDrumRoll__<segment>", which the legacy check missed. Every
    // transitionPattern lane is the EDM snare roll, so the trim applies to all.
    SamplerSound buildTransitionPatternSound(const nlohmann::json& inst, const StepChannel& ch) const {
        const std::string instName = inst["name"].get<std::string>();
        const nlohmann::json* sample = nullptr;
        for (const auto& smp : inst["samples"])
            if (smp.contains("note") && smp["note"].is_string() && smp["note"].get<std::string>() == ch.name) {
                sample = &smp;
                break;
            }
        if (!sample)
            throw std::runtime_error("Mixer: transitionPattern '" + instName + "' has no sample with note '"
                                     + ch.name + "'");
        if (!sample->contains("id") || !(*sample)["id"].is_number_integer())
            throw std::runtime_error("Mixer: transitionPattern '" + instName + "' sample '" + ch.name
                                     + "' has no integer `id`");
        SamplerSound s;
        s.data = realOr("playsample-" + std::to_string((*sample)["id"].get<long long>()) + ".ogg", stubs_.snare);
        s.keyNote = ch.n;
        s.minNote = ch.n;
        s.maxNote = ch.n;
        s.openEnded = true;  // setSoundOpenEnded(index, true)
        if (mixEnabled_) {
            if (!inst.contains("lowLevelType") || !inst["lowLevelType"].is_string())
                throw std::runtime_error("Mixer: transitionPattern '" + instName + "' has no string `lowLevelType`");
            s.gainDb = (float)(cfgTargetVol(inst["lowLevelType"].get<std::string>()) + kTransitionPatternTrackDb);
        }
        return s;
    }

    // ---- instrument index + join (moved verbatim from Render.h) ------------
    void indexInstruments(const std::vector<nlohmann::json>& instJsons) {
        instByName_.clear();
        for (const auto& j : instJsons) {
            if (j.contains("name") && j["name"].is_string())
                instByName_[j["name"].get<std::string>()] = &j;
        }
    }

    static std::string baseName(const std::string& trackName) {
        auto paren = trackName.find('(');
        if (paren != std::string::npos) return trackName.substr(0, paren);
        static const char* suffixes[] = {"-kicks", "-snares", "-toms", "-rest"};
        for (const char* s : suffixes) {
            const std::string suf = s;
            if (trackName.size() > suf.size()
                && trackName.compare(trackName.size() - suf.size(), suf.size(), suf) == 0)
                return trackName.substr(0, trackName.size() - suf.size());
        }
        return trackName;
    }

    static bool endsWith(const std::string& s, const std::string& suf) {
        return s.size() >= suf.size() && s.compare(s.size() - suf.size(), suf.size(), suf) == 0;
    }

    std::shared_ptr<SampleData> drumFixtureForName(const std::string& name) const {
        if (name.rfind("bassDrum", 0) == 0) return stubs_.kick;
        if (name.rfind("snareDrum", 0) == 0) return stubs_.snare;
        if (name.rfind("hiHat", 0) == 0) return stubs_.hat;
        return stubs_.tone;  // claps/snaps/crashes/rides/shakers/toms -> generic stub
    }

    void buildMidiSampler(const Track& track, Sampler& sampler) {
        const std::string base = baseName(track.name);
        const bool isStrums = endsWith(track.name, "(strums)");
        const bool isFret = endsWith(track.name, "(fret noises)");

        const nlohmann::json* inst = nullptr;
        auto it = instByName_.find(base);
        if (it != instByName_.end()) inst = it->second;

        // Guitar fret-noise + strum pools (docs/60 Phase 1 finish). These keep the
        // per-note sampler STRUCTURE (one sound per distinct midi note) — so the
        // no-library render is byte-identical to the old stub path — but bind each
        // note's PCM by its real playsample id when the host has staged it:
        //   - (fret noises): midi note n is an index into inst.fx.fxFretNoise[]; the
        //     id is fxFretNoise[n] (host slices the Default FX sibling into N cuts).
        //   - (strums): midi note = soundIndex+48; the step clip's channels carry
        //     (note -> strum sample key), and virtualGuitaristSamples[] maps that
        //     key -> playsample id (host stages the per-chord/fx strum mp3).
        if (isFret) {
            std::map<int, int> noteToId = fretNoteToId(inst);
            buildPerNoteSampler(track, sampler, stubs_.tone, &noteToId);
            return;
        }
        if (isStrums) {
            std::map<int, int> noteToId = strumNoteToId(track, inst);
            // Strum sounds are open-ended: each rings to its sample's end
            // (legacy Guitar.h:362 setSoundOpenEnded(index, true)).
            buildPerNoteSampler(track, sampler, stubs_.tone, &noteToId, /*openEnded*/ true);
            return;
        }
        if (inst == nullptr || !hasSamples(*inst)) {
            buildPerNoteSampler(track, sampler, stubs_.tone);
            return;
        }

        const std::string type = inst->value("type", std::string());
        const bool isBass = (type == "basses");
        auto fixture = isBass ? stubs_.bass : stubs_.tone;

        int laneFilter = 0;  // 0 = all, 1 = longNote only, 2 = short only
        if (isBass) {
            if (endsWith(track.name, "(long notes)")) laneFilter = 1;
            else if (endsWith(track.name, "(short notes)")) laneFilter = 2;
        }

        // Root MIDI note -> the slot id recorded at that root (first sample wins,
        // matching the old std::map dedup). The id keys the real sliced PCM the
        // host staged via setSample; absent -> the lane fixture stub.
        std::map<int, int> rootToId;
        for (const auto& s : (*inst)["samples"]) {
            const std::string noteStr = s.value("note", std::string());
            const std::string sType = s.value("type", std::string());
            if (laneFilter == 1 && sType != "longNote") continue;
            if (laneFilter == 2 && sType == "longNote") continue;
            if (noteStr.empty()) continue;
            rootToId.emplace(music::getMidiNoteNumber(noteStr), s.value("id", -1));
        }
        if (rootToId.empty()) { buildPerNoteSampler(track, sampler, fixture); return; }

        std::vector<int> roots, ids;
        for (const auto& kv : rootToId) { roots.push_back(kv.first); ids.push_back(kv.second); }
        int zoneStart = 0;
        for (size_t i = 0; i < roots.size(); ++i) {
            int zoneEnd;
            if (i + 1 == roots.size()) zoneEnd = 180;
            else zoneEnd = roots[i] + (roots[i + 1] - roots[i]) / 2;
            SamplerSound s;
            s.data = realOr(idKey(ids[i]), fixture);
            s.keyNote = roots[i];
            s.minNote = zoneStart;
            s.maxNote = std::min(zoneEnd, 127);
            s.openEnded = false;
            sampler.addSound(s);
            zoneStart = zoneEnd + 1;
        }
    }

    // Decimal string key for a slot id (the tonal/bass real-sample key); an empty
    // string for a missing id never matches, so realOr returns the fixture.
    static std::string idKey(int id) { return id >= 0 ? std::to_string(id) : std::string(); }

    // The real PCM registered under `key` if present and non-empty, else
    // `fallback`. Empty registry (no library) => always the fallback => the
    // no-library render is byte-identical to the stub-only path.
    std::shared_ptr<SampleData> realOr(const std::string& key,
                                       std::shared_ptr<SampleData> fallback) const {
        if (!key.empty()) {
            auto it = samplesById_.find(key);
            if (it != samplesById_.end() && it->second && it->second->frames > 0)
                return it->second;
        }
        return fallback;
    }

    // One sound per distinct midi note (keyNote==min==max). `noteToId`, when
    // given, maps a note to a real playsample id whose staged PCM replaces the
    // fixture for that note (an absent note / id, or an empty registry, leaves the
    // fixture — so the no-library render is byte-identical to the stub-only path).
    void buildPerNoteSampler(const Track& track, Sampler& sampler,
                             std::shared_ptr<SampleData> fixture,
                             const std::map<int, int>* noteToId = nullptr,
                             bool openEnded = false) {
        std::map<int, bool> notes;
        for (const auto& c : track.clips)
            if (c.type == "midi")
                for (const auto& n : c.notes) notes[n.n] = true;
        for (const auto& kv : notes) {
            SamplerSound s;
            int id = -1;
            if (noteToId) {
                auto it = noteToId->find(kv.first);
                if (it != noteToId->end()) id = it->second;
            }
            s.data = realOr(idKey(id), fixture);
            s.keyNote = kv.first;
            s.minNote = kv.first;
            s.maxNote = kv.first;
            s.openEnded = openEnded;
            sampler.addSound(s);
        }
    }

    // Guitar fret-noise note -> playsample id. The fret track's midi notes are
    // raw indices into inst.fx.fxFretNoise[] (Guitar.h getFretNoises: n = sounds[i]);
    // the id at that index is the playsample the host sliced out of the Default FX
    // sibling. Empty when there is no inst / no pool (=> every note stays stub).
    std::map<int, int> fretNoteToId(const nlohmann::json* inst) const {
        std::map<int, int> out;
        if (!inst || !inst->contains("fx")) return out;
        const auto& fx = (*inst)["fx"];
        if (!fx.contains("fxFretNoise") || !fx["fxFretNoise"].is_array()) return out;
        const auto& arr = fx["fxFretNoise"];
        for (int i = 0; i < (int)arr.size(); ++i)
            if (arr[i].is_number()) out[i] = (int)arr[i].get<double>();
        return out;
    }

    // Guitar strum note -> playsample id. The strums step clip carries one channel
    // per used sound slot: (note = soundIndex+48, name = the strum sample key);
    // virtualGuitaristSamples[] maps that same key -> the playsample id. Joining
    // the two gives note -> id. Empty when there is no inst / pool / step channels.
    std::map<int, int> strumNoteToId(const Track& track, const nlohmann::json* inst) const {
        std::map<int, int> out;
        if (!inst || !inst->contains("virtualGuitaristSamples")) return out;

        // sample key -> playsample id (mirrors the resolver's availKeys formula:
        // fx string, else "<chord>_<pos>_<type>" — see Resolver::resolveGuitarInstrument).
        std::map<std::string, int> keyToId;
        for (const auto& s : (*inst)["virtualGuitaristSamples"]) {
            const int id = s.value("id", -1);
            if (id < 0) continue;
            const std::string fx = (s.contains("fx") && s["fx"].is_string())
                ? s["fx"].get<std::string>() : std::string();
            std::string key;
            if (!fx.empty()) {
                key = fx;
            } else {
                const std::string chord = s.value("chord", std::string());
                const int pos = jsonToInt(s, "chordPosition", 1);
                const std::string type = s.value("type", std::string());
                key = chord + "_" + std::to_string(pos) + "_" + type;
            }
            keyToId.emplace(key, id);  // first-wins, like the resolver's keyToIndex
        }

        for (const auto& c : track.clips) {
            if (c.type != "step") continue;
            for (const auto& ch : c.channels) {
                if (ch.name.empty()) continue;  // padded (60,"") slot — no sample
                auto it = keyToId.find(ch.name);
                if (it != keyToId.end()) out[ch.n] = it->second;
            }
        }
        return out;
    }

    static int jsonToInt(const nlohmann::json& obj, const char* field, int def) {
        if (!obj.contains(field)) return def;
        const auto& v = obj[field];
        if (v.is_number()) return (int)v.get<double>();
        if (v.is_string()) { try { return std::stoi(v.get<std::string>()); } catch (...) { return def; } }
        return def;
    }

    static bool hasSamples(const nlohmann::json& inst) {
        return inst.contains("samples") && inst["samples"].is_array()
               && !inst["samples"].empty();
    }

    // Phase 2 Scope A: a track's lowLevelType (the mix-table key) via the inst join.
    // Empty when no instrument matches (e.g. the shared transitions track) -> caller
    // treats as 0 dB / no-op. Guitar fret/strum/short/long tracks share the guitar
    // inst's lowLevelType (baseName strips the "(...)" suffix).
    std::string laneLowLevelType(const std::string& trackName) const {
        auto it = instByName_.find(baseName(trackName));
        if (it == instByName_.end() || it->second == nullptr) return std::string();
        const auto& inst = *it->second;
        if (inst.contains("lowLevelType") && inst["lowLevelType"].is_string())
            return inst["lowLevelType"].get<std::string>();
        return std::string();
    }

    // Phase 2 Scope B: the fxGroup submix a track routes to. Drum step tracks split
    // by their suffix (the "-kicks" lane -> the kicks submix, the rest -> drums,
    // mirroring Sequencer.cpp's kick split); every other lane maps its lowLevelType
    // through the typeMappingTable (mix::getFxGroup, default "drums").
    std::string laneFxGroup(const Track& track) const {
        const std::string& nm = track.name;
        if (endsWith(nm, "-kicks")) return "kicks";
        if (endsWith(nm, "-snares") || endsWith(nm, "-toms") || endsWith(nm, "-rest")) return "drums";
        if (nm.find("Transitions") != std::string::npos) return "fx";  // shared transition lane -> fx submix
        const std::string llt = laneLowLevelType(nm);
        if (llt.empty()) return "drums";   // fallback (FX.h:368)
        return cfgFxGroup(llt);
    }

    // docs/64 — per-lane lookups via the runtime mix config when set, else the
    // compiled-in MixTables.h (identical values; the parity gate guarantees it).
    double cfgTargetVol(const std::string& t) const {
        return mixCfg_ ? mixCfg_->targetVolume(t, genre_) : mix::getInstrumentTargetVolume(t, genre_);
    }
    const std::string& cfgFxGroup(const std::string& t) const {
        return mixCfg_ ? mixCfg_->fxGroup(t) : mix::getFxGroup(t);
    }
    mix::FxSends cfgLaneSends(const std::string& group, const std::string& t) const {
        return mixCfg_ ? mixCfg_->laneSends(group, t, genre_) : mix::laneSendsDb(group, t, genre_);
    }

    // Streaming master gain (setMasterGain); 1.0 is a no-op (byte-identical).
    void applyMasterGain(AudioBuffer& out, int n) {
        if (masterGain_ == 1.0f) return;
        for (int ch = 0; ch < out.getNumChannels(); ++ch) {
            float* d = out.getWritePointer(ch);
            for (int i = 0; i < n; ++i) d[i] *= masterGain_;
        }
    }

    // Scope D — apply this lane's signalProcessors automation to laneScratch_ for
    // the block at song time `tSec`: a lowpass cutoff sweep + a dB volume ramp
    // (cutoff/gain held per block — fine for the multi-second risers).
    void applyLaneAutomation(Lane& lane, double tSec, int n) {
        if (lane.lp && !lane.lpAuto.empty()) {
            lane.lp->setCutoff(evalCurve(lane.lpAuto, tSec, 30000.0));   // open before/after window
            for (int ch = 0; ch < 2; ++ch) {
                float* d = laneScratch_.getWritePointer(ch);
                for (int i = 0; i < n; ++i) d[i] = lane.lp->processSample(ch, d[i]);
            }
        }
        if (!lane.volAuto.empty()) {
            const float g = evalVolumeGain(lane.volAuto, tSec);
            if (g != 1.0f)
                for (int ch = 0; ch < 2; ++ch) {
                    float* d = laneScratch_.getWritePointer(ch);
                    for (int i = 0; i < n; ++i) d[i] *= g;
                }
        }
    }

    // Volume automation -> linear gain, interpolated in Tracktion FADER-POSITION
    // space (Instrument.cpp:96 decibelsToVolumeFaderPosition + linear curve seg),
    // NOT in dB. Endpoints equal dbToGain(dB); only the between-points fade shape
    // changes (matches native's faster-rising fade-in). Unity before the first
    // point; last value held after the last.
    static float evalVolumeGain(const std::vector<AutoPoint>& pts, double t) {
        if (pts.empty() || t < pts.front().tSec) return 1.0f;
        if (t >= pts.back().tSec)
            return mix::faderPosToGain(mix::dbToFaderPos(pts.back().value));
        for (size_t i = 0; i + 1 < pts.size(); ++i)
            if (t >= pts[i].tSec && t < pts[i + 1].tSec) {
                const double u = (t - pts[i].tSec) / (pts[i + 1].tSec - pts[i].tSec);
                const double p0 = mix::dbToFaderPos(pts[i].value);
                const double p1 = mix::dbToFaderPos(pts[i + 1].value);
                return mix::faderPosToGain(p0 + u * (p1 - p0));
            }
        return mix::faderPosToGain(mix::dbToFaderPos(pts.back().value));
    }

    // Tracktion AutomationCurve::getValueAt port. `beforeVal` for t before the first
    // point (open filter), last value held after the last. Each segment's shape is
    // the LEFT point's curve (curve1==0 -> linear; |curve|<=0.5 -> one-control-point
    // bezier). Coincident points (lowPass open-anchor at a step's time) jump.
    static double evalCurve(const std::vector<AutoPoint>& pts, double t, double beforeVal) {
        if (pts.empty()) return beforeVal;
        if (t < pts.front().tSec) return beforeVal;
        if (t >= pts.back().tSec) return pts.back().value;
        for (size_t i = 0; i + 1 < pts.size(); ++i)
            if (t >= pts[i].tSec && t < pts[i + 1].tSec) {
                const double x1 = pts[i].tSec,     y1 = pts[i].value;
                const double x2 = pts[i + 1].tSec, y2 = pts[i + 1].value;
                if (x2 <= x1) return y2;                            // coincident -> jump
                if (pts[i].curve == 0.0 || y1 == y2) {             // linear (curve1==0)
                    const double u = (t - x1) / (x2 - x1);
                    return y1 + u * (y2 - y1);
                }
                return bezierYFromX(t, x1, y1, x2, y2, pts[i].curve);
            }
        return pts.back().value;
    }

    // Tracktion getBezierPoint (c = clamp(curve*2,-1,1)) + tracktion_Bezier
    // getBezierYFromX, the |curve| <= 0.5 path (curve is the LEFT/segment point).
    static double bezierYFromX(double t, double x1, double y1, double x2, double y2, double curve) {
        const double c = std::max(-1.0, std::min(1.0, curve * 2.0));
        double xb, yb;
        if (y2 > y1) {
            const double run = x2 - x1, rise = y2 - y1;
            const double xc = x1 + run / 2, yc = y1 + rise / 2;
            xb = xc - run / 2 * -c;  yb = yc + rise / 2 * -c;
        } else {
            const double run = x2 - x1, rise = y1 - y2;
            const double xc = x1 + run / 2, yc = y2 + rise / 2;
            xb = xc - run / 2 * -c;  yb = yc - rise / 2 * -c;
        }
        if (x1 == x2 || y1 == y2) return y1;
        if (t <= x1) return y1;
        if (t >= x2) return y2;
        const double a = x1 - 2 * xb + x2;
        const double b = -2 * x1 + 2 * xb;
        const double cc = x1 - t;
        double tt;
        if (a == 0.0) { tt = -cc / b; }
        else {
            tt = (-b + std::sqrt(b * b - 4 * a * cc)) / (2 * a);
            if (tt < 0.0 || tt > 1.0) tt = (-b - std::sqrt(b * b - 4 * a * cc)) / (2 * a);
        }
        return std::pow(1 - tt, 2) * y1 + 2 * tt * (1 - tt) * yb + std::pow(tt, 2) * y2;
    }

    // Phase 2 Scope A: a drum sub-instrument's lowLevelType, from the Drums inst's
    // `subInstruments` map keyed by the step-channel name (e.g. "bassDrum1" ->
    // "kickDrumsElectronic"). Empty (-> 0 dB) when absent.
    static std::string drumSubLowLevelType(const nlohmann::json& drumInst, const std::string& subName) {
        if (!drumInst.contains("subInstruments") || !drumInst["subInstruments"].is_object())
            return std::string();
        const auto& subs = drumInst["subInstruments"];
        auto it = subs.find(subName);
        if (it == subs.end() || !it->is_object()) return std::string();
        const auto& sub = *it;
        if (sub.contains("lowLevelType") && sub["lowLevelType"].is_string())
            return sub["lowLevelType"].get<std::string>();
        return std::string();
    }

    double sampleRate_;
    int blockSize_;
    double tailSec_;
    StubSamples stubs_;
    // Tracktion StepClip channel default velocity (defaultNoteValue 96), as a 0..1 scale.
    static constexpr float kStepChannelVelocity = 96.0f / 127.0f;
    // Sequencer.cpp:170-177 — the EDM snare roll track volume (see
    // buildTransitionPatternSound).
    static constexpr double kTransitionPatternTrackDb = -12.0;
    float masterGain_ = 1.0f;
    bool mastering_ = false;
    bool mixEnabled_ = false;       // Phase 2 Scope A — default off => byte-identical
    const mix::MixConfig* mixCfg_ = nullptr;  // docs/64 runtime config (else MixTables.h fallback)
    std::string genre_;             // from ResolvedEvents.genre, for the mix-table lookup

    double secPerBeat_ = 0.5;
    long totalFrames_ = 0;
    long pos_ = 0;
    std::vector<Lane> lanes_;
    std::unique_ptr<MixGraph> graph_;     // built only when mixEnabled_ (Scope B)
    AudioBuffer laneScratch_;             // per-lane render buffer (graph path)
    AudioBuffer seekScratch_;             // discarded output of the seek pre-roll
    std::vector<Group> groups_;           // instrument lanes (gain + meters)
    static constexpr double kGainRampSec = 0.010;  // lane-gain ramp (10 ms, click-free)
    int gainRampFrames_ = 441;
    int meterBinFrames_ = 0;              // 0 = meters off
    int meterBins_ = 0;
    bool meterSuspended_ = false;         // seek pre-roll is not metered
    std::unordered_map<std::string, const nlohmann::json*> instByName_;
    std::unordered_map<std::string, std::shared_ptr<SampleData>> samplesById_;
};

} // namespace casperaki
