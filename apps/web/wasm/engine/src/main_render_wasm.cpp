// WASM render entry point — the streaming-mixer half of the engine for the
// browser (docs/60 Phase 1 step 6). Exposes a small C ABI an AudioWorklet (or a
// headless Node parity harness) drives:
//
//   build, once, off the audio thread:
//     mixer_config(sampleRate, blockSize)
//     mixer_set_sample(role, ch0, ch1, frames, channels, sampleRate)   x5
//     mixer_build(songPtr, songLen, instBlobPtr, instLensPtr, instCount) -> totalFrames
//   then, per render quantum on the audio thread:
//     mixer_pull(numFrames)            -- render the next block (clears + fills)
//     mixer_left() / mixer_right()     -- planar float* into the wasm heap
//
// Built STANDALONE (no JS glue) so the worklet can WebAssembly.instantiate() the
// raw bytes directly (the /wasm-tone precedent). The mixer core (audio/Mixer.h)
// is OggDecode-free: JS supplies already-decoded PCM (decodeAudioData) keyed by
// role; the C++ owns the track->sampler join + the pull loop. stb_vorbis is NEVER
// compiled here — it is the native-only adapter.
//
// `malloc`/`free` are exported so JS can stage the song/inst/sample bytes in the
// heap before calling in. Memory growth is OFF (a fixed, generous INITIAL_MEMORY)
// so the Float32Array views JS makes over mixer_left()/right() never detach.

#include "Resolver.h"
#include "audio/Mixer.h"
#include "../vendor/json.hpp"

#include <cstdint>
#include <cstring>
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
    int lastError = 0;           // 0 ok, 1 resolve/build threw
    bool mixEnabled = false;     // Phase 2 Scope A — set before mixer_build
};

State& state() {
    static State s;
    return s;
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
        for (auto& kv : s.idSamples) s.mixer->setSample(kv.first, kv.second);
        s.mixer->build(ev, instJsons);
        return (int)s.mixer->totalFrames();
    } catch (...) {
        s.lastError = 1;
        s.mixer.reset();
        return 0;
    }
}

int mixer_last_error() { return state().lastError; }

// Phase 2 Scope A: enable the per-instrument-group mix (per-lane gainDb). Call
// BEFORE mixer_build (the gains are bound during build). Default off keeps the
// render byte-identical to the Phase-1 path.
void mixer_set_mix_enabled(int enabled) { state().mixEnabled = (enabled != 0); }

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

float* mixer_left() { return state().block.getWritePointer(0); }
float* mixer_right() { return state().block.getWritePointer(1); }
int mixer_total_frames() { return state().mixer ? (int)state().mixer->totalFrames() : 0; }
double mixer_sample_rate() { return state().sampleRate; }

} // extern "C"
