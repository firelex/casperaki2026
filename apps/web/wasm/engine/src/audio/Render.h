// Offline render driver (docs/60 Phase 1). A THIN wrapper over the streaming
// Mixer (audio/Mixer.h): decode the stub fixtures with the native OGG adapter,
// hand them to the mixer, pull the whole song one 128-frame block at a time, and
// peak-normalise the assembled master for the WAV. The mix/join logic lives in
// the mixer so the browser worklet shares it (and never compiles stb_vorbis).
//
//   IR track --(name + lane kind)--> a Sampler with its multisample zones
//   IR midi/step clips --> scheduled MIDI note-on/off events (absolute samples)
//   IR wave clips --> the decoded loop/transition fixture, tiled across the clip
//   all per-source block buffers summed --> stereo master --> peak-norm --> WAV
//
// The block loop is PULL-BASED (docs/57f lesson): Mixer::pullBlock yields the
// next block; the driver never lets the engine drive itself.
//
// Sample backing: the real library isn't staged locally, so each logical sound
// maps to one of the bundled stub fixtures (apps/engine-spike/samples/), mirroring
// the native render's no-library fallback (prestage-samples.mjs): drums by role
// (kick/snare/hat, else tone), bass -> bass-c2, every other tonal/wave -> tone.
// Timing and relative pitch are faithful; only the timbres are placeholders.
#pragma once

#include "../ResolvedEvents.h"
#include "../../vendor/json.hpp"
#include "AudioBuffer.h"
#include "Mixer.h"
#include "OggDecode.h"
#include "SampleLibrary.h"
#include "Sampler.h"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

namespace casperaki {

struct RenderConfig {
    std::string samplesDir;          // dir holding kick/snare/hat/tone/bass-c2.ogg
    double sampleRate = 44100.0;
    double tailSec = 2.5;            // extra tail so ADSR release / sample decay rings out
    int blockSize = 128;

    // Real sample library (docs/60 Phase 1 finish). When both are set, the
    // renderer decodes/slices the genre's real assets (asset-manifest.json in
    // `genreDir`, resolved against `libraryRoot`) and binds them into the mixer
    // before build; unset/missing assets fall back to the role stubs, so the
    // no-library render is byte-identical to the stub-only path.
    std::string libraryRoot;         // CASPERAKI_SAMPLE_LIBRARY_ROOT ("" = stubs only)
    std::string genreDir;            // envelope dir holding asset-manifest.json

    // Phase 2 Scope A: enable the per-instrument-group mix (per-lane gainDb). Default
    // off keeps the render byte-identical to Phase 1.
    bool mixEnabled = false;

    // Skip the final peak-normalise (render at natural level). Useful for A/B against
    // the native engine, which does not peak-normalise a sparse render.
    bool noNormalize = false;

    // docs/64 — path to the shared mix-config.json. When set (and mixEnabled), the
    // per-lane volumes/sends/fxGroups + rack chains are read from it at runtime
    // instead of the compiled-in tables. Empty -> compiled-in fallback (identical).
    std::string mixConfigPath;
};

class Renderer {
public:
    explicit Renderer(const RenderConfig& cfg) : cfg_(cfg) { loadFixtures(); }

    // Stats from the last render's real-sample load (zeroed when no library).
    const SampleLibraryStats& lastLibraryStats() const { return libStats_; }

    // instJsons: the parsed inst-N.json configs (for the track->sampler join).
    AudioBuffer render(const ResolvedEvents& ev, const std::vector<nlohmann::json>& instJsons) {
        Mixer mixer(cfg_.sampleRate, cfg_.blockSize, cfg_.tailSec, stubs_);
        mixer.setMixEnabled(cfg_.mixEnabled);

        // docs/64 — load the shared mix config (kept alive for the whole render).
        std::unique_ptr<mix::MixConfig> mixCfg;
        if (cfg_.mixEnabled && !cfg_.mixConfigPath.empty()) {
            mixCfg = std::make_unique<mix::MixConfig>(mix::MixConfig::fromFile(cfg_.mixConfigPath));
            mixer.setMixConfig(*mixCfg);
        }

        // Bind real assets (if a library is configured) BEFORE build — the join
        // looks them up there; anything absent falls back to a stub.
        libStats_ = SampleLibraryStats{};
        if (!cfg_.libraryRoot.empty() && !cfg_.genreDir.empty()) {
            SampleLibrary lib(cfg_.libraryRoot, kPad);
            libStats_ = lib.loadInto(mixer, std::filesystem::path(cfg_.genreDir), instJsons);
        }

        mixer.build(ev, instJsons);

        const long totalFrames = mixer.totalFrames();
        AudioBuffer master(2, (int)totalFrames);
        AudioBuffer block(2, cfg_.blockSize);

        for (long b = 0; b < totalFrames; b += cfg_.blockSize) {
            const int n = (int)std::min((long)cfg_.blockSize, totalFrames - b);
            mixer.pullBlock(block, n);
            for (int ch = 0; ch < 2; ++ch)
                master.copyFrom(ch, (int)b, block, ch, 0, n);
        }

        lastNormalizeGain_ = cfg_.noNormalize ? 1.0f : peakNormalize(master, 0.9f);
        return master;
    }

    // The gain the last render's peak-normalise multiplied the whole song by (1.0
    // when skipped or silent). A real-time player that wants the same level as
    // this WAV applies it as its fixed master gain (mixer_set_master_gain).
    float lastNormalizeGain() const { return lastNormalizeGain_; }

private:
    // ---- fixtures (native OGG decode) -------------------------------------
    void loadFixtures() {
        stubs_.kick = loadFixture("kick.ogg");
        stubs_.snare = loadFixture("snare.ogg");
        stubs_.hat = loadFixture("hat.ogg");
        stubs_.tone = loadFixture("tone.ogg");
        stubs_.bass = loadFixture("bass-c2.ogg");
    }

    std::shared_ptr<SampleData> loadFixture(const std::string& file) {
        auto data = std::make_shared<SampleData>();
        const std::string path = cfg_.samplesDir + "/" + file;
        DecodedAudio dec = decodeOggFile(path);
        if (!dec.ok) {
            // Keep the renderer alive with a tiny silent placeholder; the missing
            // fixture is reported by main_render so the run is still observable.
            data->audio.setSize(1, kPad);
            data->frames = 0;
            data->sampleRate = (int)cfg_.sampleRate;
            return data;
        }
        // Pad with trailing zeros so the Lagrange lookahead / pitch-up overshoot
        // can never read past the end.
        const int ch = dec.buffer.getNumChannels();
        const int frames = dec.buffer.getNumSamples();
        data->audio.setSize(ch, frames + kPad);
        for (int c = 0; c < ch; ++c)
            data->audio.copyFrom(c, 0, dec.buffer, c, 0, frames);
        data->frames = frames;
        data->sampleRate = dec.sampleRate;
        return data;
    }

    float peakNormalize(AudioBuffer& buf, float target) {
        float peak = 0.0f;
        for (int ch = 0; ch < buf.getNumChannels(); ++ch) {
            const float* d = buf.getReadPointer(ch);
            for (int i = 0; i < buf.getNumSamples(); ++i)
                peak = std::max(peak, std::fabs(d[i]));
        }
        // Don't normalise an effectively-silent render. The old 1e-9 guard only
        // caught pure digital zero, so a near-silent buffer (e.g. an empty solo
        // lane, or denormal/dither floor) got its noise floor amplified all the
        // way up to `target` -> audible white noise. ~-80 dBFS cleanly separates
        // silence from any real musical content (which peaks far higher).
        if (peak <= 1e-4f) return 1.0f;
        const float g = target / peak;
        for (int ch = 0; ch < buf.getNumChannels(); ++ch) {
            float* d = buf.getWritePointer(ch);
            for (int i = 0; i < buf.getNumSamples(); ++i) d[i] *= g;
        }
        return g;
    }

    static constexpr int kPad = 8192;

    RenderConfig cfg_;
    StubSamples stubs_;
    SampleLibraryStats libStats_;
    float lastNormalizeGain_ = 1.0f;
};

} // namespace casperaki
