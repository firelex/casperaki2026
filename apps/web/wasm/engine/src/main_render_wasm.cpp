// WASM render entry point — the streaming-mixer half of the engine for the
// browser (docs/60 Phase 1 step 6). Exposes a small C ABI an AudioWorklet (or a
// headless Node parity harness) drives:
//
//   build, once, off the audio thread:
//     mixer_config(sampleRate, blockSize)
//     mixer_set_sample(role, ch0, ch1, frames, channels, sampleRate)   x5
//     mixer_set_sample_id(key, keyLen, ch0, ch1, frames, channels, sampleRate)  x N
//     mixer_set_mix_enabled(1)          -- optional: per-lane mix + rack FX
//     mixer_set_mix_config(json, len)   -- REQUIRED when the mix is on: the text
//                                          of casperaki_engine/config/mix-config.json
//     mixer_build(songPtr, songLen, instBlobPtr, instLensPtr, instCount) -> totalFrames
//     mixer_set_master_gain(g)          -- optional fixed output gain
//   then, per render quantum on the audio thread:
//     mixer_pull(numFrames)            -- render the next block (clears + fills)
//     mixer_left() / mixer_right()     -- planar float* into the wasm heap
//     mixer_seek(frame, prerollFrames) -- move the play position (no allocation)
//     mixer_position()                 -- frame the next pull renders from
//   instrument lanes (sequencer rows), after mixer_build:
//     mixer_lane_count(), mixer_lane_name(i) + mixer_lane_name_length(i)
//     mixer_set_lane_gain(i, gain)     -- mute/solo, 10 ms ramp, no allocation
//     mixer_enable_meters(binFrames)   -- before mixer_build (or right after,
//                                         before taking the L/R views)
//     mixer_meter_bin_count(), mixer_lane_peaks(i), mixer_lane_rms(i)
//   errors: a call that fails returns 0 / -1 and sets mixer_last_error() and
//   mixer_last_error_message() (NUL-terminated UTF-8 in the heap).
//
// Built STANDALONE (no JS glue) so the worklet can WebAssembly.instantiate() the
// raw bytes directly (the /wasm-tone precedent). The mixer core (audio/Mixer.h)
// is OggDecode-free: JS supplies already-decoded PCM (decodeAudioData) keyed by
// role; the C++ owns the track->sampler join + the pull loop. stb_vorbis is NEVER
// compiled here — it is the native-only adapter.
//
// `malloc`/`free` are exported so JS can stage the song/inst/sample bytes in the
// heap before calling in. Memory growth is ON (see build-wasm.sh), but every
// allocation happens while staging/building, so the Float32Array views JS makes
// over mixer_left()/right() after mixer_build never detach (pull and seek do not
// allocate).

#include "Resolver.h"
#include "audio/MixConfig.h"
#include "audio/Mixer.h"
#include "../vendor/json.hpp"

#include <cstdint>
#include <cstring>
#include <exception>
#include <memory>
#include <string>
#include <vector>

using namespace casperaki;

namespace {

struct State {
    StubSamples stubs;
    // Real, decoded (tonal: already sliced) PCM staged by JS, keyed by the join's
    // string id. The mixer doesn't exist until mixer_build, so these are held here
    // and bound onto it right after construction (before build).
    std::vector<std::pair<std::string, std::shared_ptr<SampleData>>> idSamples;
    std::unique_ptr<Mixer> mixer;
    AudioBuffer block;            // pull output (planar, blockSize wide)
    double sampleRate = 44100.0;
    int blockSize = 128;
    double tailSec = 2.5;
    // 0 ok, 1 resolve/build threw, 2 mix on but no mix config, 3 mix config
    // invalid, 4 seek failed, 5 lane/meter call failed. lastErrorMessage says
    // what went wrong.
    int lastError = 0;
    std::string lastErrorMessage;
    bool mixEnabled = false;     // Phase 2 Scope A — set before mixer_build
    int meterBinFrames = 0;      // mixer_enable_meters before build (0 = off)
    // The shared mix-config.json (volumes, sends, fxGroups, rack chains), parsed
    // from text JS hands in. The Mixer keeps a pointer, so it lives here.
    std::unique_ptr<mix::MixConfig> mixConfig;
};

State& state() {
    static State s;
    return s;
}

void setError(State& s, int code, const std::string& message) {
    s.lastError = code;
    s.lastErrorMessage = message;
}

// Runs `f` on the built mixer; on failure records error 5 and returns `bad`.
template <class R, class F>
R laneCall(const char* what, R bad, F f) {
    State& s = state();
    if (!s.mixer) {
        setError(s, 5, std::string(what) + ": no mixer (mixer_build has not succeeded)");
        return bad;
    }
    try {
        return f(*s.mixer);
    } catch (const std::exception& e) {
        setError(s, 5, std::string(what) + ": " + e.what());
        return bad;
    }
}


// SampleData with the same +pad margin the native loader uses, so the Lagrange
// lookahead / pitch-up overshoot can never read past the end.
std::shared_ptr<SampleData> makeSample(const float* ch0, const float* ch1, int frames,
                                       int channels, int sampleRate) {
    auto data = std::make_shared<SampleData>();
    const int pad = 8192;
    channels = channels < 1 ? 1 : (channels > 2 ? 2 : channels);
    data->audio.setSize(channels, frames + pad);
    if (frames > 0) {
        if (ch0) std::memcpy(data->audio.getWritePointer(0), ch0, sizeof(float) * (size_t)frames);
        if (channels >= 2 && ch1)
            std::memcpy(data->audio.getWritePointer(1), ch1, sizeof(float) * (size_t)frames);
    }
    data->frames = frames;
    data->sampleRate = sampleRate;
    return data;
}

} // namespace

extern "C" {

void mixer_config(double sampleRate, int blockSize) {
    State& s = state();
    s.sampleRate = sampleRate;
    s.blockSize = blockSize;
    s.block.setSize(2, blockSize);
    s.idSamples.clear();
}

// role: 0=kick 1=snare 2=hat 3=tone 4=bass. Planar channel pointers (ch1 ignored
// for mono). Call all five BEFORE mixer_build (the join binds the PCM at build).
void mixer_set_sample(int role, const float* ch0, const float* ch1, int frames,
                      int channels, int sampleRate) {
    State& s = state();
    auto data = makeSample(ch0, ch1, frames, channels, sampleRate);
    switch (role) {
        case 0: s.stubs.kick = data; break;
        case 1: s.stubs.snare = data; break;
        case 2: s.stubs.hat = data; break;
        case 3: s.stubs.tone = data; break;
        case 4: s.stubs.bass = data; break;
        default: break;
    }
}

// Real-sample variant (docs/60 Phase 1 finish): push already-decoded PCM keyed by
// the join's string id (tonal slot id / drum name / "playsample-<id>.ogg"). For
// tonal lanes JS has already sliced [sliceStart,sliceEnd]. `key` is `keyLen` bytes
// of UTF-8 (no NUL needed). Call all of these BEFORE mixer_build; absent keys fall
// back to the role stubs, so a partial library still renders.
void mixer_set_sample_id(const char* key, int keyLen, const float* ch0, const float* ch1,
                         int frames, int channels, int sampleRate) {
    State& s = state();
    auto data = makeSample(ch0, ch1, frames, channels, sampleRate);
    s.idSamples.emplace_back(std::string(key, (size_t)keyLen), std::move(data));
}

// Resolve song.json (+ the concatenated inst JSON blob) and build the mixer.
// instLens is an int32[instCount] of byte lengths slicing instBlob in order.
// Returns totalFrames, or 0 on error (see mixer_last_error()).
int mixer_build(const char* song, int songLen, const char* instBlob,
                const int* instLens, int instCount) {
    State& s = state();
    s.lastError = 0;
    s.lastErrorMessage.clear();
    if (s.mixEnabled && !s.mixConfig) {
        s.mixer.reset();
        setError(s, 2, "mixer_build: the mix is enabled but no mix config was given "
                       "(call mixer_set_mix_config with mix-config.json first)");
        return 0;
    }
    try {
        std::string songJson(song, (size_t)songLen);
        std::vector<std::string> instStrings;
        std::vector<nlohmann::json> instJsons;
        instStrings.reserve((size_t)instCount);
        instJsons.reserve((size_t)instCount);
        int off = 0;
        for (int i = 0; i < instCount; ++i) {
            const int len = instLens[i];
            instStrings.emplace_back(instBlob + off, (size_t)len);
            off += len;
            try {
                instJsons.push_back(nlohmann::json::parse(instStrings.back()));
            } catch (...) {
                instJsons.push_back(nlohmann::json::object());
            }
        }

        Resolver resolver;
        ResolvedEvents ev = resolver.resolve(songJson, instStrings);

        s.mixer = std::make_unique<Mixer>(s.sampleRate, s.blockSize, s.tailSec, s.stubs);
        // Same switch as the native CASPERAKI_MIX=1 render (Render.h).
        s.mixer->setMixEnabled(s.mixEnabled);
        if (s.mixEnabled) s.mixer->setMixConfig(*s.mixConfig);
        if (s.meterBinFrames > 0) s.mixer->enableMeters(s.meterBinFrames);
        for (auto& kv : s.idSamples) s.mixer->setSample(kv.first, kv.second);
        s.mixer->build(ev, instJsons);
        return (int)s.mixer->totalFrames();
    } catch (const std::exception& e) {
        s.mixer.reset();
        setError(s, 1, std::string("mixer_build: ") + e.what());
        return 0;
    } catch (...) {
        s.mixer.reset();
        setError(s, 1, "mixer_build: unknown exception");
        return 0;
    }
}

int mixer_last_error() { return state().lastError; }

// NUL-terminated description of the last error ("" when none).
const char* mixer_last_error_message() { return state().lastErrorMessage.c_str(); }

// Phase 2 Scope A: enable the per-instrument-group mix (per-lane gainDb). Call
// BEFORE mixer_build (the gains are bound during build). Default off keeps the
// render byte-identical to the Phase-1 path.
void mixer_set_mix_enabled(int enabled) { state().mixEnabled = (enabled != 0); }

// docs/64: hand in the text of casperaki_engine/config/mix-config.json (`len`
// bytes of UTF-8, no NUL needed) — the same file the native render reads. Call
// BEFORE mixer_build; required when the mix is enabled. Any already-built mixer
// is discarded (it points at the old config): call mixer_build again.
// Returns 1 on success, 0 if the JSON is not a valid mix config (see the error).
int mixer_set_mix_config(const char* json, int len) {
    State& s = state();
    s.lastError = 0;
    s.lastErrorMessage.clear();
    s.mixer.reset();
    s.mixConfig.reset();
    try {
        s.mixConfig = std::make_unique<mix::MixConfig>(
            mix::MixConfig::fromJson(nlohmann::json::parse(std::string(json, (size_t)len))));
        return 1;
    } catch (const std::exception& e) {
        setError(s, 3, std::string("mixer_set_mix_config: ") + e.what());
        return 0;
    }
}

// Optional fixed master gain for the RT path (no look-ahead normalisation).
void mixer_set_master_gain(float g) {
    if (state().mixer) state().mixer->setMasterGain(g);
}

// Render the next `numFrames` (<= blockSize) into the internal block. Returns 1
// while audio remains (position < totalFrames), 0 once past the end (the block is
// silence beyond the end). Safe to call with no mixer (emits silence).
int mixer_pull(int numFrames) {
    State& s = state();
    if (!s.mixer) {
        s.block.clear();
        return 0;
    }
    const bool more = s.mixer->pullBlock(s.block, numFrames);
    return more ? 1 : 0;
}

// Move the play position to `frame` (0..mixer_total_frames()) so the next
// mixer_pull continues from there. Voices already sounding at that point are
// recreated mid-note; the FX racks are warmed by silently rendering the
// `prerollFrames` before it (0 = instant, racks keep their old tails; a few
// seconds = the reverb/delay tails of the music before the point). Does not
// allocate. Returns the new position, or -1 on error (see mixer_last_error).
int mixer_seek(int frame, int prerollFrames) {
    State& s = state();
    if (!s.mixer) {
        setError(s, 4, "mixer_seek: no mixer (mixer_build has not succeeded)");
        return -1;
    }
    try {
        s.mixer->seek((long)frame, (long)prerollFrames);
        return (int)s.mixer->position();
    } catch (const std::exception& e) {
        setError(s, 4, e.what());
        return -1;
    }
}

// ---- instrument lanes ---------------------------------------------------------
// Number of instrument lanes (one per instrument name, in track order), -1 on error.
int mixer_lane_count() {
    return laneCall("mixer_lane_count", -1, [](Mixer& m) { return m.laneCount(); });
}

// Lane i's name: NUL-terminated UTF-8 (the inst-N.json `name`, e.g. "Bass"), or
// null on error. mixer_lane_name_length gives its byte length (-1 on error).
const char* mixer_lane_name(int lane) {
    return laneCall("mixer_lane_name", (const char*)nullptr,
                    [lane](Mixer& m) { return m.laneName(lane).c_str(); });
}
// The resolved mix (Mixer::laneInfoJson): NUL-terminated UTF-8 JSON, or null on
// error; mixer_lane_info_length gives its byte length. Valid until the next call.
const char* mixer_lane_info() {
    return laneCall("mixer_lane_info", (const char*)nullptr, [](Mixer& m) { return m.laneInfoJson().c_str(); });
}
int mixer_lane_info_length() {
    return laneCall("mixer_lane_info_length", -1, [](Mixer& m) { return (int)m.laneInfoJson().size(); });
}

int mixer_lane_name_length(int lane) {
    return laneCall("mixer_lane_name_length", -1,
                    [lane](Mixer& m) { return (int)m.laneName(lane).size(); });
}

// Live lane gain (0 = mute), ramped over 10 ms from the next pull. Safe between
// pulls on the audio thread (no allocation). Returns 1, or 0 on error.
int mixer_set_lane_gain(int lane, float gain) {
    return laneCall("mixer_set_lane_gain", 0, [lane, gain](Mixer& m) {
        m.setLaneGain(lane, gain);
        return 1;
    });
}

// Opt into per-lane meters with bins of `binFrames` frames. Before mixer_build it
// is remembered and applied at build; after it, the arrays are allocated now
// (heap growth: take the L/R views afterwards). Returns 1, or 0 on error.
int mixer_enable_meters(int binFrames) {
    State& s = state();
    if (binFrames <= 0) {
        setError(s, 5, "mixer_enable_meters: binFrames must be > 0");
        return 0;
    }
    s.meterBinFrames = binFrames;
    if (!s.mixer) return 1;
    return laneCall("mixer_enable_meters", 0, [binFrames](Mixer& m) {
        m.enableMeters(binFrames);
        return 1;
    });
}

// Bins per lane (ceil(totalFrames / binFrames)), -1 on error.
int mixer_meter_bin_count() {
    return laneCall("mixer_meter_bin_count", -1, [](Mixer& m) { return m.meterBinCount(); });
}

// Lane i's per-bin peak / RMS (float[mixer_meter_bin_count()] in the heap), or
// null on error. Filled in as the song is pulled.
// Device views: probe the plugin at `slot` of bus `bus` (UTF-8, `len` bytes);
// slot < 0 turns the probe off. Returns 1, or 0 on error (mixer_last_error).
int mixer_set_probe(const char* bus, int len, int slot) {
    return laneCall("mixer_set_probe", 0, [bus, len, slot](Mixer& m) {
        m.setProbe(std::string(bus, (size_t)len), slot);
        return 1;
    });
}
// Read and reset the probe into mixer_probe_buffer(): in peak, in RMS, out peak,
// out RMS, frames. Returns 1, or 0 on error.
static float g_probe[5];
int mixer_probe_read() {
    return laneCall("mixer_probe_read", 0, [](Mixer& m) {
        m.readProbe(g_probe);
        return 1;
    });
}
const float* mixer_probe_buffer() { return g_probe; }

// Peak per meter bin of a bus (0 reverb, 1 delay, 2 chorus return, 3 master), or null.
const float* mixer_bus_peaks(int bus) {
    return laneCall("mixer_bus_peaks", (const float*)nullptr, [bus](Mixer& m) { return m.busPeaks(bus); });
}

const float* mixer_lane_peaks(int lane) {
    return laneCall("mixer_lane_peaks", (const float*)nullptr,
                    [lane](Mixer& m) { return m.lanePeaks(lane); });
}
const float* mixer_lane_rms(int lane) {
    return laneCall("mixer_lane_rms", (const float*)nullptr,
                    [lane](Mixer& m) { return m.laneRms(lane); });
}

// The frame the next mixer_pull renders from (0 with no mixer).
int mixer_position() { return state().mixer ? (int)state().mixer->position() : 0; }

float* mixer_left() { return state().block.getWritePointer(0); }
float* mixer_right() { return state().block.getWritePointer(1); }
int mixer_total_frames() { return state().mixer ? (int)state().mixer->totalFrames() : 0; }
double mixer_sample_rate() { return state().sampleRate; }

} // extern "C"
