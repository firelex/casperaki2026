// Sampler voice model — aligned to Tracktion's te::SamplerPlugin, the sampler the
// native engine ACTUALLY renders with (config.h: USE_TE_SAMPLER, so
// SHOULD_APPLY_ADSR=0). SamplerSound + SampledNote + the 32-voice note-on/off
// allocator. (An earlier revision ported CasperakiSamplerPlugin — the DISABLED
// variant carrying a per-voice ADSR: a 1ms attack + 2s release the product never
// applies, audible as a "less smooth"/duller piano and, because the envelope was
// applied to the shared mix buffer, a chord-onset amplitude wobble. te::SamplerPlugin
// has NO per-voice envelope; it only bakes a 30-sample concave anti-click fade into
// each loaded sample — see SampleLibrary::makeRange.)
// One Sampler instance == one tracktion sampler plugin == one rendered track. It
// owns a soundList (the multisample zones) and the live playingNotes, and renders
// pull-style 128-frame blocks driven by scheduled MIDI events.
//
// RT-safety (docs/60 Phase 1 step 6): a glitch-free AudioWorklet wants ZERO
// audio-thread allocation. So the 32 voices are PREALLOCATED in a pool reused via
// a free-list (no make_unique on noteOn), and the stop-fade's resample scratch is
// a single per-Sampler buffer (no AudioBuffer alloc inside addNextBlock). Voice
// activation order, processing order and arithmetic are byte-for-byte unchanged —
// only the storage is pooled — so the offline WAV stays bit-identical.
//
// Port notes:
//   - velocity is hardcoded 0.75f at note-on (CasperakiSamplerPlugin.cpp:281,362)
//     — the humanized MIDI velocity never reaches voice gain, so a no-FX render
//     is deterministic (memory wasm-engine-phase1-sampler).
//   - resampling is the vendored Lagrange interpolator (Interpolator.h); the gain
//     chain is the tracktion fader/pan dance (Gain.h).
//   - NO per-voice ADSR (te::SamplerPlugin has none). The only onset shaping is
//     the 30-sample concave fade-in baked into each sample at load (SampleLibrary
//     ::makeRange, mirroring te SamplerSound::setExcerpt); note-off truncates to
//     the 8-sample stop + the existing stop-crossfade.
//   - note→sound is EVERY sound whose [minNote,maxNote] spans the note (layering),
//     capped at 32 simultaneous voices.
#pragma once

#include "AudioBuffer.h"
#include "Gain.h"
#include "Interpolator.h"

#include <algorithm>
#include <cmath>
#include <memory>
#include <stdexcept>
#include <vector>

namespace casperaki {

// A decoded sample shared by every SamplerSound that points at it. Padded with
// trailing zeros so the Lagrange interpolator's lookahead / playback-ratio
// overshoot can never read past the end (native pads audioData by +32; we use a
// generous margin so even multi-octave pitch-ups stay in bounds).
struct SampleData {
    AudioBuffer audio;     // planar float, includes trailing zero pad
    int frames = 0;        // real (non-pad) frame count == fileLengthSamples
    int sampleRate = 44100;
};

// A multisample zone: which decoded sample, its root key, the key span it covers,
// and the per-sound gain/pan. Mirrors CasperakiSamplerPlugin::SamplerSound after
// createSampler() has run setSoundParams/setSoundGains/setSoundOpenEnded.
struct SamplerSound {
    std::shared_ptr<SampleData> data;
    int keyNote = 72;
    int minNote = 48;
    int maxNote = 96;
    float gainDb = 0.0f;
    float pan = 0.0f;
    bool openEnded = false;
};

class SampledNote {
public:
    // Default-constructible so the Sampler can preallocate a voice pool; the real
    // setup happens in init() (mirrors the old constructor) on each note-on.
    SampledNote() = default;

    // Reinitialise this pooled voice for a fresh note-on. Byte-for-byte equivalent
    // to constructing a new SampledNote — every field is overwritten.
    void init(int midiNote, int keyNote, float velocity,
              std::shared_ptr<SampleData> data, double engineSampleRate,
              int sampleDelayFromBufferStart, int fileLengthSamples, float gainDb,
              float pan, bool openEndedFlag) {
        note = midiNote;
        offset = -sampleDelayFromBufferStart;
        data_ = std::move(data);
        openEnded = openEndedFlag;
        isFinished = false;
        startFade = 1.0f;

        resampler_[0].reset();
        resampler_[1].reset();

        sampledNoteGains(gainDb, velocity, pan, gains_[0], gains_[1]);

        const double hz = midiNoteInHertz(midiNote);
        playbackRatio = hz / midiNoteInHertz(keyNote);
        playbackRatio *= (double)data_->sampleRate / engineSampleRate;
        samplesLeftToPlay = playbackRatio > 0 ? (1 + (int)(fileLengthSamples / playbackRatio)) : 0;
    }

    // Faithful transcription of SampledNote::addNextBlock — resample-add the next
    // chunk into outBuffer, then run the stop fade-out. No per-voice envelope
    // (te::SamplerPlugin has none; the onset fade is baked into the sample at load).
    // `fadeScratch` is a caller-owned scratch buffer (shared across the Sampler's
    // voices, reused per block) so the fade path allocates nothing on the audio
    // thread; it is sized >= the needed length by the Sampler before the call.
    void addNextBlock(AudioBuffer& outBuffer, int startSamp, int numSamples,
                      AudioBuffer& fadeScratch) {
        if (offset < 0) {
            const int num = std::min(-offset, numSamples);
            startSamp += num;
            numSamples -= num;
            offset += num;
        }

        int numSamps = std::min(numSamples, samplesLeftToPlay);

        if (numSamps > 0) {
            int numUsed = 0;
            const int srcCh = data_->audio.getNumChannels();
            for (int i = std::min(2, outBuffer.getNumChannels()); --i >= 0;) {
                numUsed = resampler_[i].processAdding(
                    playbackRatio,
                    data_->audio.getReadPointer(std::min(i, srcCh - 1), offset),
                    outBuffer.getWritePointer(i, startSamp),
                    numSamps,
                    gains_[i]);
            }
            offset += numUsed;
            samplesLeftToPlay -= numSamps;
        }

        if (numSamples > numSamps && startFade > 0.0f) {
            startSamp += numSamps;
            numSamps = numSamples - numSamps;
            float endFade;

            if (numSamps > 100) {
                endFade = 0.0f;
                numSamps = 100;
            } else {
                endFade = std::max(0.0f, startFade - numSamps * 0.01f);
            }

            const int numSampsNeeded = 2 + (int)std::lround((numSamps + 2) * playbackRatio);
            const int srcCh = data_->audio.getNumChannels();
            // Shared scratch, grown by the Sampler to >= numSampsNeeded+8. Only the
            // [0, numSampsNeeded) region is filled/read, matching the old freshly-
            // allocated buffer (the tail is never read by the resampler).
            AudioBuffer& scratch = fadeScratch;

            if (offset + numSampsNeeded < data_->audio.getNumSamples()) {
                for (int i = srcCh; --i >= 0;)
                    scratch.copyFrom(i, 0, data_->audio, i, offset, numSampsNeeded);
            } else {
                for (int i = srcCh; --i >= 0;)
                    std::fill(scratch.getWritePointer(i), scratch.getWritePointer(i) + numSampsNeeded, 0.0f);
            }

            if (numSampsNeeded > 2)
                applyCrossfadeSection(scratch, 0, numSampsNeeded - 2, startFade, endFade);

            startFade = endFade;

            int numUsed = 0;
            for (int i = std::min(2, outBuffer.getNumChannels()); --i >= 0;)
                numUsed = resampler_[i].processAdding(
                    playbackRatio,
                    // Clamp by srcCh (not the shared scratch's allocated channel
                    // count) so a mono sample reads channel 0 for both outputs —
                    // matching the old per-call scratch that had exactly srcCh chans.
                    scratch.getReadPointer(std::min(i, srcCh - 1)),
                    outBuffer.getWritePointer(i, startSamp),
                    numSamps,
                    gains_[i]);
            offset += numUsed;

            if (startFade <= 0.0f) isFinished = true;
        }
    }

    // Seek support: fast-forward a freshly init()'d voice (no start delay) by
    // `numFrames` output frames, leaving it exactly where a full render would have
    // it — same input offset, same resampler ring + phase, same samples left. The
    // caller guarantees numFrames < samplesLeftToPlay (the voice is still playing).
    void skipFrames(int numFrames) {
        if (offset != 0 || numFrames >= samplesLeftToPlay)
            throw std::logic_error("SampledNote::skipFrames: voice not fresh or skip past its end");
        int numUsed = 0;
        const int srcCh = data_->audio.getNumChannels();
        for (int i = 2; --i >= 0;)
            numUsed = resampler_[i].skip(playbackRatio,
                                         data_->audio.getReadPointer(std::min(i, srcCh - 1), offset),
                                         numFrames);
        offset += numUsed;
        samplesLeftToPlay -= numFrames;
    }

    // Upper bound on the stop-fade scratch length this voice can ask for, so the
    // Sampler can size the shared buffer once. numSamps in the fade path is capped
    // at 100; numSampsNeeded = 2 + lround((numSamps+2)*playbackRatio).
    int maxFadeScratchLen() const {
        return 2 + (int)std::lround((100 + 2) * playbackRatio) + 8;
    }

    int note = 0;
    int offset = 0;
    int samplesLeftToPlay = 0;
    bool openEnded = false;
    bool isFinished = false;
    float startFade = 1.0f;

private:
    // tracktion AudioFadeCurve::applyCrossfadeSection (linear): ramp every channel
    // of [start, start+num) by a linear gain from g1 to g2.
    static void applyCrossfadeSection(AudioBuffer& buf, int start, int num, float g1, float g2) {
        if (num <= 0) return;
        for (int ch = 0; ch < buf.getNumChannels(); ++ch) {
            float* d = buf.getWritePointer(ch, start);
            for (int i = 0; i < num; ++i) {
                const float t = (float)i / (float)num;
                d[i] *= g1 + (g2 - g1) * t;
            }
        }
    }

    LagrangeInterpolator resampler_[2];
    std::shared_ptr<SampleData> data_;
    float gains_[2] = {1.0f, 1.0f};
    double playbackRatio = 1.0;
};

class Sampler {
public:
    explicit Sampler(double engineSampleRate = 44100.0) : engineSampleRate_(engineSampleRate) {
        // Preallocate the 32-voice pool + the free-list once; never reallocated on
        // the audio thread (the pool vector is sized here and pointers into it stay
        // stable because we never resize it again).
        pool_.resize(kMaxVoices);
        playing_.reserve(kMaxVoices);
        free_.reserve(kMaxVoices);
        for (int i = kMaxVoices - 1; i >= 0; --i) free_.push_back(&pool_[(size_t)i]);
        fadeScratch_.setSize(2, kInitFadeScratch);
    }

    void addSound(const SamplerSound& s) { soundList_.push_back(s); }
    int numSounds() const { return (int)soundList_.size(); }

    // Phase 2 Scope A: set the per-lane mix gain on every sound (the tonal/guitar/
    // bass track VolumeAndPanPlugin level). Equivalent to a post-sampler track gain
    // because sampledNoteGains is linear in dB (gainDb adds, linear multiplies).
    // Drum lanes set gainDb per sound instead (different sub-instrument volumes).
    void setAllSoundGainDb(float db) { for (auto& s : soundList_) s.gainDb = db; }

    // Note-on at an intra-block sample offset: spawn a voice per matching zone
    // (layering), capped at 32 simultaneous voices — CasperakiSamplerPlugin.cpp:
    // 350-375. Velocity 0..1 (= native getFloatVelocity = midiVel/127); defaults to
    // the legacy 0.75 for the no-mix path. Voices come from the pool.
    void noteOn(int note, int sampleDelayFromBufferStart, float velocity = 0.75f) {
        // A new note-on first stops any non-open-ended voice already playing this
        // pitch, exactly as a note-off would (te::SamplerPlugin.cpp:311-320).
        noteOff(note, sampleDelayFromBufferStart);
        for (auto& ss : soundList_) {
            if (ss.minNote <= note && ss.maxNote >= note && ss.data && ss.data->frames > 0
                && (int)playing_.size() < kMaxVoices) {
                SampledNote* v = free_.back();
                free_.pop_back();
                v->init(note, ss.keyNote, velocity, ss.data, engineSampleRate_,
                        sampleDelayFromBufferStart, ss.data->frames, ss.gainDb, ss.pan,
                        ss.openEnded);
                ensureFadeScratch(v->maxFadeScratchLen());
                playing_.push_back(v);
            }
        }
    }

    // Seek support: silence every voice and return it to the pool (no allocation).
    void allVoicesOff() {
        for (auto* v : playing_) free_.push_back(v);
        playing_.clear();
    }

    // Seek support: recreate the voices of a note that started `elapsed` output
    // frames before the seek point, as a full render would have them now. Zones
    // whose sample has already run out are skipped; so are non-open-ended zones
    // when the note was already released (`released`) — what is left of those is
    // at most the ~100-sample stop fade. Same layering + 32-voice cap as noteOn.
    void restoreNote(int note, float velocity, long elapsed, bool released) {
        for (auto& ss : soundList_) {
            if (!(ss.minNote <= note && ss.maxNote >= note && ss.data && ss.data->frames > 0))
                continue;
            if (released && !ss.openEnded) continue;
            if ((int)playing_.size() >= kMaxVoices) return;
            SampledNote* v = free_.back();
            v->init(note, ss.keyNote, velocity, ss.data, engineSampleRate_, 0, ss.data->frames,
                    ss.gainDb, ss.pan, ss.openEnded);
            if (elapsed >= (long)v->samplesLeftToPlay) continue;  // already ran out
            free_.pop_back();
            v->skipFrames((int)elapsed);
            ensureFadeScratch(v->maxFadeScratchLen());
            playing_.push_back(v);
        }
    }

    // Note-off: (unless openEnded) truncate the sample tail to the 8-sample stop +
    // the stop-crossfade, exactly as te::SamplerPlugin::applyToBuffer does on an
    // isNoteOff message. No ADSR release (te::SamplerPlugin has no release stage).
    void noteOff(int note, int noteTimeSample) {
        for (auto* v : playing_) {
            if (v->note == note && !v->openEnded)
                v->samplesLeftToPlay = std::min(v->samplesLeftToPlay,
                                                std::max(kMinSamplesWhenStopping, noteTimeSample));
        }
    }

    // Render one block: caller has already dispatched this block's note-on/off
    // events. outBuffer is cleared and filled with [0, numSamples) of audio.
    // Finished voices are returned to the pool. Reverse iteration + erase preserves
    // the exact voice order/arithmetic of the old vector<unique_ptr> path.
    void processBlock(AudioBuffer& outBuffer, int numSamples) {
        for (int i = (int)playing_.size(); --i >= 0;) {
            SampledNote* sn = playing_[(size_t)i];
            sn->addNextBlock(outBuffer, 0, numSamples, fadeScratch_);
            if (sn->isFinished) {
                free_.push_back(sn);
                playing_.erase(playing_.begin() + i);
            }
        }
    }

    bool hasActiveVoices() const { return !playing_.empty(); }

private:
    void ensureFadeScratch(int len) {
        if (len > fadeScratch_.getNumSamples())
            fadeScratch_.setSize(2, len);  // rare grow (extreme pitch-up); then stable
    }

    static constexpr int kMaxVoices = 32;
    static constexpr int kMinSamplesWhenStopping = 8;
    static constexpr int kInitFadeScratch = 4096;  // covers playbackRatio up to ~40x

    double engineSampleRate_;
    std::vector<SamplerSound> soundList_;
    std::vector<SampledNote> pool_;        // 32 preallocated voices
    std::vector<SampledNote*> playing_;    // active voices, insertion order
    std::vector<SampledNote*> free_;       // available pool slots
    AudioBuffer fadeScratch_;              // shared stop-fade scratch (per Sampler)
};

} // namespace casperaki
