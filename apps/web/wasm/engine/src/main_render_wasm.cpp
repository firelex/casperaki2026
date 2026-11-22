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
//     mixer_set_mastering(1)            -- optional: legacy mastering stage
//                                          (+5 dB into NC-17; needs the mix)
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
// Matched mastering (audio/Matchering.h, the server's `casperaki_master sergree`):
//   offline, in a worker (no mixer needed):
//     master_analyze(left, right, frames, style) -> frames after the 15 s minimum
//     master_profile_bytes() + master_profile_bytes_length()  -- the profile, serialised
//     master_apply()                  -- the CLI's apply loop over the analysed song
//     master_output_left() / master_output_right() / master_output_frames()
//     master_release()                -- free the song buffers
//   live, in the playback worklet (see "Live mastering" below):
//     mixer_set_live_mastering(1)     -- before mixer_build
//     live_pull(numFrames)            -- instead of mixer_pull; output in mixer_left/right
//     live_seek(frame, prerollFrames) -- instead of mixer_seek
//     live_set_loop(start, end)       -- the loop, handled on the engine's input side
//     live_set_profile(bytes, len)    -- switch from the stand-in to the matched master
//     live_position(), live_latency_frames(), live_matched()
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
#include "audio/Matchering.h"
#include "audio/MixConfig.h"
#include "audio/Mixer.h"
#include "../vendor/json.hpp"

#include <climits>
#include <cstdint>
#include <cstring>
#include <exception>
#include <memory>
#include <string>
#include <vector>

using namespace casperaki;

namespace {

// Live mastering (the playback worklet). The engine renders `delay` frames
// ahead of what is heard, delay = MasteringStream::latencyFrames() of the SERGREE
// stream, in BOTH modes, so switching from the stand-in to the matched master
// never moves the clock:
//  - every raw (unmastered) block the mixer renders is written to a ring, with
//    the song frame of each sample (a loop jump makes them non-contiguous);
//  - stand-in (no profile yet): output = the ring `delay` frames back, +5 dB into
//    the mixer's NC-17 (exactly the in-graph stand-in mixer_set_mastering uses);
//  - matched: output = the MasteringStream fed with each raw block as it is
//    rendered; its output is the master of the frame `delay` back.
// A seek re-renders `kFftSize` frames of history (the FIR's length) plus `delay`
// ahead, so the stream holds the music before the new position. The stream itself
// is never reset (it cannot seek): after a seek only its limiter and dither state
// differ from a render from the start. The live stream gets a profile whose
// numFrames/convolvedFrames are unbounded, since a looping song has no fixed
// length; the offline master's quirk of leaving the last 1..4096 frames silent
// (convolvedFrames) therefore does not apply live (they fall in the song's tail).
struct LiveMaster {
    static constexpr int kRing = 16384;       // >= kFftSize + delay + one block
    static constexpr int kCrossfade = 2048;   // stand-in -> matched, ~46 ms
    int delay = 0;
    std::vector<float> ringL, ringR;
    std::vector<long> ringPos;                // song frame of each ring sample
    int64_t written = 0;                      // raw frames written (free-running)
    AudioBuffer raw, scratch, standIn, discard;
    std::unique_ptr<aw::Plugin> standInLimiter;
    float standInBoost = 1.0f;
    std::unique_ptr<matchering::MasteringStream> stream;
    int crossfadeLeft = 0;
    long loopStart = -1, loopEnd = -1;
};

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
    bool mastering = false;      // docs/67 #1 — legacy mastering stage
    int meterBinFrames = 0;      // mixer_enable_meters before build (0 = off)
    // The shared mix-config.json (volumes, sends, fxGroups, rack chains), parsed
    // from text JS hands in. The Mixer keeps a pointer, so it lives here.
    std::unique_ptr<mix::MixConfig> mixConfig;
    // Matched mastering: the live layer (worklet) and the offline buffers (worker).
    bool liveMastering = false;  // mixer_set_live_mastering before mixer_build
    LiveMaster live;
    AudioBuffer masterSong, masterOut;
    matchering::MasteringProfile profile;
    bool haveProfile = false;
    std::vector<uint8_t> profileBytes;
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


// ---- matched mastering helpers ---------------------------------------------

// Profile wire format (little-endian, wasm and x86 alike): "CMP1", then the
// scalars in MasteringProfile order, then the two filters (int32 length + taps).
constexpr uint32_t kProfileMagic = 0x31504D43u;  // "CMP1"

template <class T> void put(std::vector<uint8_t>& out, T v) {
    const auto* b = reinterpret_cast<const uint8_t*>(&v);
    out.insert(out.end(), b, b + sizeof(T));
}
template <class T> T take(const uint8_t*& p, const uint8_t* end) {
    if ((size_t)(end - p) < sizeof(T)) throw std::invalid_argument("mastering profile: truncated");
    T v;
    std::memcpy(&v, p, sizeof(T));
    p += sizeof(T);
    return v;
}

std::vector<uint8_t> serializeProfile(const matchering::MasteringProfile& pr) {
    std::vector<uint8_t> out;
    put<uint32_t>(out, kProfileMagic);
    put<int32_t>(out, pr.style == matchering::Style::Sergree ? 0 : 1);
    put<int32_t>(out, pr.numFrames);
    put<int32_t>(out, pr.convolvedFrames);
    put<float>(out, pr.rmsCoefficient);
    put<float>(out, pr.preLimiterGain);
    put<float>(out, pr.limiterLouder);
    put<float>(out, pr.limiterOutput);
    put<float>(out, pr.finalGain);
    put<uint32_t>(out, pr.ditherSeedL);
    put<uint32_t>(out, pr.ditherSeedR);
    put<float>(out, pr.targetMatchRms);
    put<float>(out, pr.referenceMatchRms);
    put<int32_t>(out, pr.numMidPieces);
    put<int32_t>(out, pr.numSidePieces);
    for (const auto* fir : {&pr.midFir, &pr.sideFir}) {
        put<int32_t>(out, (int32_t)fir->size());
        for (float v : *fir) put<float>(out, v);
    }
    return out;
}

matchering::MasteringProfile deserializeProfile(const uint8_t* p, int len) {
    if (!p || len <= 0) throw std::invalid_argument("mastering profile: empty");
    const uint8_t* end = p + len;
    if (take<uint32_t>(p, end) != kProfileMagic) throw std::invalid_argument("mastering profile: bad magic");
    matchering::MasteringProfile pr;
    const int32_t style = take<int32_t>(p, end);
    if (style != 0 && style != 1) throw std::invalid_argument("mastering profile: bad style");
    pr.style = style == 0 ? matchering::Style::Sergree : matchering::Style::BoostAndLimit;
    pr.numFrames = take<int32_t>(p, end);
    pr.convolvedFrames = take<int32_t>(p, end);
    pr.rmsCoefficient = take<float>(p, end);
    pr.preLimiterGain = take<float>(p, end);
    pr.limiterLouder = take<float>(p, end);
    pr.limiterOutput = take<float>(p, end);
    pr.finalGain = take<float>(p, end);
    pr.ditherSeedL = take<uint32_t>(p, end);
    pr.ditherSeedR = take<uint32_t>(p, end);
    pr.targetMatchRms = take<float>(p, end);
    pr.referenceMatchRms = take<float>(p, end);
    pr.numMidPieces = take<int32_t>(p, end);
    pr.numSidePieces = take<int32_t>(p, end);
    for (auto* fir : {&pr.midFir, &pr.sideFir}) {
        const int32_t n = take<int32_t>(p, end);
        if (n < 0 || n > (1 << 20)) throw std::invalid_argument("mastering profile: bad filter length");
        fir->resize((size_t)n);
        for (auto& v : *fir) v = take<float>(p, end);
    }
    if (p != end) throw std::invalid_argument("mastering profile: trailing bytes");
    return pr;
}

// The latency of a SERGREE stream, read from MasteringStream itself (a throwaway
// stream over silent filters; built once, off the audio path, at mixer_build).
int sergreeLatencyFrames() {
    matchering::MasteringProfile probe;
    probe.style = matchering::Style::Sergree;
    probe.numFrames = 1;
    const auto seeds = matchering::CasperakiNC17::ditherSeedsOfFreshProcess();
    probe.ditherSeedL = seeds.first;
    probe.ditherSeedR = seeds.second;
    probe.midFir.assign((size_t)matchering::kFftSize, 0.0f);
    probe.sideFir.assign((size_t)matchering::kFftSize, 0.0f);
    return matchering::MasteringStream(probe).latencyFrames();
}

// Render `n` (<= blockSize) raw frames from the mixer into live.raw and the ring,
// jumping at the loop end like the worklet's own loop (instant seek).
void livePullRaw(State& s, int n) {
    LiveMaster& l = s.live;
    Mixer& m = *s.mixer;
    int at = 0;
    auto chunk = [&](int len) {
        const long from = m.position();
        m.pullBlock(l.scratch, len);
        for (int i = 0; i < len; ++i) {
            const size_t k = (size_t)((l.written + i) % LiveMaster::kRing);
            const float a = l.scratch.getReadPointer(0)[i], b = l.scratch.getReadPointer(1)[i];
            l.ringL[k] = a;
            l.ringR[k] = b;
            l.ringPos[k] = from + i;
            l.raw.getWritePointer(0)[at + i] = a;
            l.raw.getWritePointer(1)[at + i] = b;
        }
        l.written += len;
        at += len;
    };
    const long p = m.position();
    if (l.loopEnd > 0 && p < l.loopEnd && p + n >= l.loopEnd) {
        const int head = (int)(l.loopEnd - p);
        chunk(head);
        m.seek(l.loopStart, 0);
        if (n - head > 0) chunk(n - head);
    } else {
        chunk(n);
    }
}

// Feed ring frames [from, from + count) (free-running indices) to the stream; output discarded.
void liveFeedStreamFromRing(State& s, int64_t from, int count) {
    LiveMaster& l = s.live;
    while (count > 0) {
        const int n = std::min(count, s.blockSize);
        for (int i = 0; i < n; ++i) {
            const size_t k = (size_t)((from + i) % LiveMaster::kRing);
            l.scratch.getWritePointer(0)[i] = l.ringL[k];
            l.scratch.getWritePointer(1)[i] = l.ringR[k];
        }
        l.stream->process(l.scratch.getReadPointer(0), l.scratch.getReadPointer(1), l.discard.getWritePointer(0),
                          l.discard.getWritePointer(1), n);
        from += n;
        count -= n;
    }
}

// Position the live layer so the next live_pull outputs song frame `frame`: the
// mixer renders the FIR's history before it (silence before frame 0) and `delay`
// frames past it, all through the ring and (when matched) the stream.
void livePrime(State& s, long frame, long prerollFrames) {
    LiveMaster& l = s.live;
    const long history = matchering::kFftSize;
    const long start = frame - history;
    s.mixer->seek(std::max(0L, start), prerollFrames);
    const int64_t firstWritten = l.written;
    long t = start;
    const long end = frame + l.delay;
    for (; t < 0 && t < end;) {
        const int n = (int)std::min<long>(std::min<long>(s.blockSize, -t), end - t);
        for (int i = 0; i < n; ++i) {
            const size_t k = (size_t)((l.written + i) % LiveMaster::kRing);
            l.ringL[k] = l.ringR[k] = 0.0f;
            l.ringPos[k] = t + i;
        }
        l.written += n;
        t += n;
    }
    for (; t < end;) {
        const int n = (int)std::min<long>(s.blockSize, end - t);
        livePullRaw(s, n);
        t += n;
    }
    if (l.stream) liveFeedStreamFromRing(s, firstWritten, (int)(l.written - firstWritten));
    l.crossfadeLeft = 0;
}

template <class R, class F>
R liveCall(const char* what, R bad, F f) {
    State& s = state();
    if (!s.mixer || !s.liveMastering || s.live.ringL.empty()) {
        setError(s, 7, std::string(what) + ": live mastering is not built (mixer_set_live_mastering(1) + mixer_build)");
        return bad;
    }
    try {
        return f(s, s.live);
    } catch (const std::exception& e) {
        setError(s, 7, std::string(what) + ": " + e.what());
        return bad;
    }
}

void initLive(State& s) {
    LiveMaster& l = s.live;
    if (s.sampleRate != matchering::kSampleRate)
        throw std::invalid_argument("live mastering: the matched master is locked to 44100 Hz, the engine runs at " +
                                    std::to_string(s.sampleRate) + " Hz");
    l = LiveMaster();
    l.delay = sergreeLatencyFrames();
    if (l.delay + matchering::kFftSize + s.blockSize > LiveMaster::kRing)
        throw std::logic_error("live mastering: ring too small for the stream latency");
    l.ringL.assign(LiveMaster::kRing, 0.0f);
    l.ringR.assign(LiveMaster::kRing, 0.0f);
    l.ringPos.assign(LiveMaster::kRing, 0);
    l.raw.setSize(2, s.blockSize);
    l.scratch.setSize(2, s.blockSize);
    l.standIn.setSize(2, s.blockSize);
    l.discard.setSize(2, s.blockSize);
    // The stand-in: the same stage as MixGraph's mixer_set_mastering(1). Its
    // constructor draws rand() for its dither seeds; the mixer's own generator
    // state is put back so the mix renders as it would without live mastering.
    const aw::PortableRandState randState = aw::portableRandState();
    l.standInLimiter = aw::makeNC17();
    aw::portableRandState() = randState;
    l.standInLimiter->setSampleRate(s.sampleRate);
    l.standInLimiter->setParam(0, 0.0f);
    l.standInLimiter->setParam(1, 0.89f);
    l.standInBoost = mix::dbToGain(MixGraph::kMasteringBoostDb);
    livePrime(s, 0, 0);
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
        s.mixer->setMastering(s.mastering);
        if (s.meterBinFrames > 0) s.mixer->enableMeters(s.meterBinFrames);
        for (auto& kv : s.idSamples) s.mixer->setSample(kv.first, kv.second);
        s.mixer->build(ev, instJsons);
        if (s.liveMastering) {
            if (s.mastering)
                throw std::logic_error("live mastering replaces mixer_set_mastering; turn one of them off");
            initLive(s);
        }
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

// docs/67 #1: the legacy production mastering stage (+5 dB into NC-17) on the
// output. Call BEFORE mixer_build; needs the mix on (mixer_build fails otherwise).
void mixer_set_mastering(int enabled) { state().mastering = (enabled != 0); }

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
// Device views: the impulse response of one plugin (a fresh instance with these
// params, independent of any mixer): a unit click into both channels, `frames`
// samples recorded. Returns 2 x frames floats (left, then right), valid until the
// next call, or null on error (mixer_last_error).
static std::vector<float> g_ir;
const float* mixer_impulse(const char* factory, int flen, const float* params, int nparams, int frames, int sampleRate) {
    State& s = state();
    try {
        if (frames <= 0 || frames > 30 * 48000) throw std::out_of_range("mixer_impulse: frames out of range");
        if (sampleRate <= 0) throw std::out_of_range("mixer_impulse: bad sample rate");
        const std::string f(factory, (size_t)flen);
        std::vector<float> pv(params, params + nparams);
        aw::seedPortableRand(1);
        auto plugin = casperaki::makeAwByFactory(f, (double)sampleRate, pv);
        if (!plugin) throw std::runtime_error("mixer_impulse: unknown plugin " + f);
        g_ir.assign((size_t)frames * 2, 0.0f);
        const int B = 128;
        std::vector<float> l(B), r(B);
        for (int pos = 0; pos < frames; pos += B) {
            const int n = std::min(B, frames - pos);
            std::fill(l.begin(), l.end(), 0.0f);
            std::fill(r.begin(), r.end(), 0.0f);
            if (pos == 0) { l[0] = 1.0f; r[0] = 1.0f; }
            float* ch[2] = { l.data(), r.data() };
            plugin->process(ch, ch, n);
            std::copy(l.begin(), l.begin() + n, g_ir.begin() + pos);
            std::copy(r.begin(), r.begin() + n, g_ir.begin() + frames + pos);
        }
        return g_ir.data();
    } catch (const std::exception& e) {
        setError(s, 6, e.what());
        return nullptr;
    }
}

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
// The probe's last Probe::kRing samples in and out (mono), in time order, copied
// into mixer_probe_spectrum_buffer() (2 x 4096 floats: in, then out). Returns 1, or 0.
static float g_rings[2 * casperaki::Probe::kRing];
int mixer_probe_rings() {
    return laneCall("mixer_probe_rings", 0, [](Mixer& m) {
        const auto& p = m.probe();
        const int N = casperaki::Probe::kRing;
        for (int i = 0; i < N; ++i) {
            const int k = (p.ringPos + i) % N;
            g_rings[i] = p.inRing[k];
            g_rings[N + i] = p.outRing[k];
        }
        return 1;
    });
}
const float* mixer_probe_spectrum_buffer() { return g_rings; }

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


// ---- matched mastering: offline (worker) -------------------------------------
// Error code 7 = a mastering call failed (see mixer_last_error_message).

// Analyse a whole stereo song (planar floats in the heap, 44.1 kHz) the way
// `casperaki_master` does: loop it up to 15 s when shorter, then analyze().
// style: 0 = sergree, 1 = boost. Keeps the (padded) song for master_apply and the
// profile for master_profile_bytes. Returns the padded frame count, or 0.
int master_analyze(const float* left, const float* right, int frames, int style) {
    State& s = state();
    s.lastError = 0;
    s.lastErrorMessage.clear();
    s.haveProfile = false;
    try {
        if (frames <= 0) throw std::invalid_argument("master_analyze: no frames");
        if (style != 0 && style != 1) throw std::invalid_argument("master_analyze: style must be 0 (sergree) or 1 (boost)");
        s.masterOut.setSize(0, 0);
        s.masterSong.setSize(2, frames);
        std::memcpy(s.masterSong.getWritePointer(0), left, sizeof(float) * (size_t)frames);
        std::memcpy(s.masterSong.getWritePointer(1), right, sizeof(float) * (size_t)frames);
        matchering::ensureMinimumLength(s.masterSong, matchering::kSampleRate, matchering::kMinLengthSeconds);
        s.profile = matchering::analyze(s.masterSong, matchering::kSampleRate,
                                        style == 0 ? matchering::Style::Sergree : matchering::Style::BoostAndLimit);
        s.profileBytes = serializeProfile(s.profile);
        s.haveProfile = true;
        return s.masterSong.getNumSamples();
    } catch (const std::exception& e) {
        setError(s, 7, std::string("master_analyze: ") + e.what());
        return 0;
    }
}

// The last analysed profile, serialised (null / -1 when there is none).
const uint8_t* master_profile_bytes() { return state().haveProfile ? state().profileBytes.data() : nullptr; }
int master_profile_bytes_length() { return state().haveProfile ? (int)state().profileBytes.size() : -1; }

// Apply the analysed profile to the analysed song from frame 0, exactly as
// main_master.cpp does (512-frame blocks, the latency flushed with silence, output
// frame t = song frame t). Returns the frame count, or 0. Output in
// master_output_left/right (float32, before any WAV rounding).
int master_apply() {
    State& s = state();
    s.lastError = 0;
    s.lastErrorMessage.clear();
    try {
        if (!s.haveProfile || s.masterSong.getNumSamples() == 0)
            throw std::logic_error("master_apply: call master_analyze first");
        const AudioBuffer& song = s.masterSong;
        matchering::MasteringStream stream(s.profile);
        const int latency = stream.latencyFrames();
        const int n = song.getNumSamples();
        const int total = n + latency;
        s.masterOut.setSize(2, n);
        const int block = 512;
        std::vector<float> oL((size_t)block), oR((size_t)block), iL((size_t)block), iR((size_t)block);
        for (int start = 0; start < total; start += block) {
            const int len = std::min(block, total - start);
            const int fromSong = std::max(0, std::min(len, n - start));
            std::fill(iL.begin(), iL.end(), 0.0f);
            std::fill(iR.begin(), iR.end(), 0.0f);
            if (fromSong > 0) {
                std::copy(song.getReadPointer(0, start), song.getReadPointer(0, start) + fromSong, iL.begin());
                std::copy(song.getReadPointer(1, start), song.getReadPointer(1, start) + fromSong, iR.begin());
            }
            stream.process(iL.data(), iR.data(), oL.data(), oR.data(), len);
            for (int i = 0; i < len; ++i) {
                const int t = start + i - latency;
                if (t >= 0 && t < n) {
                    s.masterOut.getWritePointer(0)[t] = oL[(size_t)i];
                    s.masterOut.getWritePointer(1)[t] = oR[(size_t)i];
                }
            }
        }
        return n;
    } catch (const std::exception& e) {
        setError(s, 7, std::string("master_apply: ") + e.what());
        return 0;
    }
}

int master_output_frames() { return state().masterOut.getNumSamples(); }
const float* master_output_left() { return state().masterOut.getNumSamples() ? state().masterOut.getReadPointer(0) : nullptr; }
const float* master_output_right() { return state().masterOut.getNumSamples() ? state().masterOut.getReadPointer(1) : nullptr; }

// Free the analysed song and the output (the profile stays).
void master_release() {
    State& s = state();
    s.masterSong = AudioBuffer();
    s.masterOut = AudioBuffer();
}

// ---- matched mastering: live (playback worklet) --------------------------------

// Before mixer_build: run the live mastering layer (stand-in until a profile
// arrives, then the matched master). Replaces mixer_set_mastering.
void mixer_set_live_mastering(int enabled) { state().liveMastering = (enabled != 0); }


// Frames the engine renders ahead of what is heard (the SERGREE stream latency).
int live_latency_frames() {
    return liveCall("live_latency_frames", -1, [](State&, LiveMaster& l) { return l.delay; });
}

// 1 once the matched master plays (live_set_profile succeeded), else 0; -1 on error.
int live_matched() {
    return liveCall("live_matched", -1, [](State&, LiveMaster& l) { return l.stream ? 1 : 0; });
}

// The song frame the next live_pull outputs first.
int live_position() {
    return liveCall("live_position", -1, [](State&, LiveMaster& l) {
        return (int)l.ringPos[(size_t)((l.written - l.delay) % LiveMaster::kRing)];
    });
}

// Render the next `numFrames` (<= blockSize) of mastered output into the block
// mixer_left/right point at. Does not allocate. Returns 1 while the output is
// inside the song, 0 once past its end, -1 on error.
int live_pull(int numFrames) {
    return liveCall("live_pull", -1, [numFrames](State& s, LiveMaster& l) {
        if (numFrames <= 0 || numFrames > s.blockSize) throw std::out_of_range("numFrames outside 1..blockSize");
        const int n = numFrames;
        const int64_t outStart = l.written - l.delay;  // ring index of the first output frame
        const long firstPos = l.ringPos[(size_t)(outStart % LiveMaster::kRing)];
        livePullRaw(s, n);
        float* oL = s.block.getWritePointer(0);
        float* oR = s.block.getWritePointer(1);
        if (l.stream)
            l.stream->process(l.raw.getReadPointer(0), l.raw.getReadPointer(1), oL, oR, n);
        if (!l.stream || l.crossfadeLeft > 0) {
            float* sL = l.standIn.getWritePointer(0);
            float* sR = l.standIn.getWritePointer(1);
            for (int i = 0; i < n; ++i) {
                const size_t k = (size_t)((outStart + i) % LiveMaster::kRing);
                sL[i] = l.ringL[k] * l.standInBoost;
                sR[i] = l.ringR[k] * l.standInBoost;
            }
            float* io[2] = {sL, sR};
            l.standInLimiter->process(io, io, n);
            if (!l.stream) {
                std::copy(sL, sL + n, oL);
                std::copy(sR, sR + n, oR);
            } else {
                // Linear crossfade from the stand-in to the matched master.
                const float total = (float)LiveMaster::kCrossfade;
                for (int i = 0; i < n; ++i) {
                    const float a = std::min(1.0f, (float)(LiveMaster::kCrossfade - l.crossfadeLeft + i + 1) / total);
                    oL[i] = a * oL[i] + (1.0f - a) * sL[i];
                    oR[i] = a * oR[i] + (1.0f - a) * sR[i];
                }
                l.crossfadeLeft = std::max(0, l.crossfadeLeft - n);
            }
        }
        return firstPos < s.mixer->totalFrames() ? 1 : 0;
    });
}

// Move the output to song frame `frame` (0..mixer_total_frames()): the mixer is
// seeked (with `prerollFrames` of silent effect pre-roll) to the FIR history
// before `frame` and renders up to `delay` frames past it. Allocation-free.
// Returns the new output position, or -1.
int live_seek(int frame, int prerollFrames) {
    return liveCall("live_seek", -1, [frame, prerollFrames](State& s, LiveMaster&) {
        if (frame < 0 || frame > s.mixer->totalFrames())
            throw std::out_of_range("frame " + std::to_string(frame) + " outside the song");
        livePrime(s, frame, prerollFrames);
        return frame;
    });
}

// Set the loop (frames, start < 0 = off). Crossing `end` from before it jumps to
// `start` on the exact frame, on the engine's input side (instant seek), so the
// output loops `delay` frames later at the same song frame. If the engine has
// already rendered past `end` while the output is still before it, it re-renders
// from the output position (instant) so this pass loops too. Returns 1, or 0.
int live_set_loop(int start, int end) {
    return liveCall("live_set_loop", 0, [start, end](State& s, LiveMaster& l) {
        if (start < 0) {
            l.loopStart = l.loopEnd = -1;
            return 1;
        }
        if (!(end > start && end <= s.mixer->totalFrames()))
            throw std::out_of_range("bad loop " + std::to_string(start) + ".." + std::to_string(end));
        l.loopStart = start;
        l.loopEnd = end;
        const int64_t outStart = l.written - l.delay;
        const long outPos = l.ringPos[(size_t)(outStart % LiveMaster::kRing)];
        if (outPos >= end) return 1;
        bool passed = false;
        for (int64_t i = outStart; i < l.written && !passed; ++i)
            passed = l.ringPos[(size_t)(i % LiveMaster::kRing)] >= end;
        if (passed) livePrime(s, outPos, 0);
        return 1;
    });
}

// Switch to the matched master: `bytes` is a profile from master_profile_bytes
// (made in a worker from the unmastered render of this song). Allocates the
// stream (call between pulls; JS re-reads its heap views afterwards), feeds it
// the FIR's history from the ring, then crossfades from the stand-in over
// ~46 ms. Returns 1, or 0 (the stand-in keeps playing; the error says why).
int live_set_profile(const uint8_t* bytes, int len) {
    return liveCall("live_set_profile", 0, [bytes, len](State&, LiveMaster& l) {
        matchering::MasteringProfile pr = deserializeProfile(bytes, len);
        if (pr.style != matchering::Style::Sergree)
            throw std::invalid_argument("the live master needs a sergree profile");
        // A looping song has no fixed length: never cut the stream off.
        const int unbounded = (INT_MAX / matchering::kFftSize) * matchering::kFftSize;
        pr.numFrames = unbounded;
        pr.convolvedFrames = unbounded;
        auto stream = std::make_unique<matchering::MasteringStream>(pr);
        if (stream->latencyFrames() != l.delay)
            throw std::logic_error("stream latency " + std::to_string(stream->latencyFrames()) +
                                   " differs from the live delay " + std::to_string(l.delay));
        const bool first = !l.stream;
        l.stream = std::move(stream);
        const int history = matchering::kFftSize + l.delay;
        liveFeedStreamFromRing(state(), l.written - history, history);
        l.crossfadeLeft = first ? LiveMaster::kCrossfade : 0;
        return 1;
    });
}

} // extern "C"
