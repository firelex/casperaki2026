// Integration unit test for the ported sampler voice model (Sampler.h) — the
// structural/synthetic audio oracle at the voice level (the 8-genre energy oracle
// in scripts/validate-audio.mjs covers the full mix). We drive the Sampler with a
// known synthetic sample and assert the analytic consequences of the port:
//   (1) unison gain   — a note at keyNote (ratio 1) sustains at the hardcoded-0.75
//        voice gain dbToGain(-5) ≈ 0.562 times the source amplitude.
//   (2) octave-up      — a note an octave above keyNote (ratio 2) plays out in
//        about half as many energetic output samples (samplesLeftToPlay halves).
//   (3) one-shot ends  — a non-openEnded voice finishes after its sample plays out.
//   (4) layering        — two zones covering the same note stack two voices, ~2x
//        the sustained amplitude (note->sound is EVERY matching zone).

#include "../src/audio/Sampler.h"

#include <cmath>
#include <cstdio>
#include <memory>
#include <vector>

using namespace casperaki;

namespace {
int failures = 0;
void check(bool cond, const char* msg) {
    if (!cond) { std::printf("FAIL: %s\n", msg); ++failures; }
}
void checkNear(double a, double b, double tol, const char* msg) {
    if (std::fabs(a - b) > tol) {
        std::printf("FAIL: %s (%.6f vs %.6f, tol %.6f)\n", msg, a, b, tol);
        ++failures;
    }
}

// A synthetic decoded sample: `frames` of a unit sine, padded like the renderer.
std::shared_ptr<SampleData> makeSine(int frames, double samplesPerCycle, int sampleRate) {
    auto d = std::make_shared<SampleData>();
    const int pad = 8192;
    d->audio.setSize(1, frames + pad);
    float* x = d->audio.getWritePointer(0);
    const double w = 2.0 * M_PI / samplesPerCycle;
    for (int i = 0; i < frames; ++i) x[i] = (float)std::sin(w * i);
    d->frames = frames;
    d->sampleRate = sampleRate;
    return d;
}

// Render `numFrames` of a sampler into a stereo buffer (pull-style 128 blocks).
AudioBuffer renderAll(Sampler& s, int numFrames) {
    AudioBuffer out(2, numFrames);
    AudioBuffer block(2, 128);
    for (int b = 0; b < numFrames; b += 128) {
        const int n = std::min(128, numFrames - b);
        block.clear();
        s.processBlock(block, n);
        for (int ch = 0; ch < 2; ++ch) {
            const float* src = block.getReadPointer(ch);
            float* dst = out.getWritePointer(ch, b);
            for (int i = 0; i < n; ++i) dst[i] += src[i];
        }
    }
    return out;
}

float peakInRange(const AudioBuffer& b, int from, int to) {
    float p = 0.0f;
    for (int i = from; i < to; ++i) p = std::max(p, std::fabs(b.getReadPointer(0)[i]));
    return p;
}

int energeticSamples(const AudioBuffer& b, float thr) {
    int c = 0;
    for (int i = 0; i < b.getNumSamples(); ++i)
        if (std::fabs(b.getReadPointer(0)[i]) > thr) ++c;
    return c;
}
} // namespace

int main() {
    const int SR = 44100;
    const int FRAMES = 4410;  // 0.1 s source

    // (1) Unison gain: note == keyNote -> ratio 1, sustained amplitude ≈ 0.562
    //     (dbToGain(0 - 5) at velocity 0.75). Measure in the sustain region, past
    //     the 1 ms ADSR attack and the interpolator latency.
    {
        Sampler s(SR);
        SamplerSound snd;
        snd.data = makeSine(FRAMES, 32.0, SR);  // 32 samples/cycle
        snd.keyNote = 60; snd.minNote = 0; snd.maxNote = 127; snd.gainDb = 0.0f;
        s.addSound(snd);
        s.noteOn(60, 0);
        AudioBuffer out = renderAll(s, FRAMES + 1000);
        const float peak = peakInRange(out, 200, FRAMES - 200);
        checkNear(peak, std::pow(10.0f, -5.0f / 20.0f), 0.05, "unison sustain peak != dbToGain(-5)");
    }

    // (2) Octave up: note keyNote+12 -> ratio 2 -> ~half the energetic samples.
    int eUnison = 0, eOctave = 0;
    {
        Sampler s(SR);
        SamplerSound snd;
        snd.data = makeSine(FRAMES, 64.0, SR);
        snd.keyNote = 60; snd.minNote = 0; snd.maxNote = 127;
        s.addSound(snd);
        s.noteOn(60, 0);
        eUnison = energeticSamples(renderAll(s, FRAMES + 2000), 0.05f);

        Sampler s2(SR);
        s2.addSound(snd);
        s2.noteOn(72, 0);
        eOctave = energeticSamples(renderAll(s2, FRAMES + 2000), 0.05f);
    }
    check(eOctave < eUnison * 0.7 && eOctave > eUnison * 0.3,
          "octave-up should play out in roughly half the samples");

    // (3) One-shot ends: a non-openEnded voice is gone after the sample plays out
    //     plus the release tail.
    {
        Sampler s(SR);
        SamplerSound snd;
        snd.data = makeSine(FRAMES, 32.0, SR);
        snd.keyNote = 60; snd.minNote = 0; snd.maxNote = 127; snd.openEnded = false;
        s.addSound(snd);
        s.noteOn(60, 0);
        renderAll(s, FRAMES + 200);
        check(!s.hasActiveVoices(), "one-shot voice should finish after sample plays out");
    }

    // (4) Layering: two zones over the same note -> two stacked voices -> ~2x the
    //     sustained amplitude.
    {
        Sampler s(SR);
        SamplerSound snd;
        snd.data = makeSine(FRAMES, 32.0, SR);
        snd.keyNote = 60; snd.minNote = 0; snd.maxNote = 127; snd.gainDb = 0.0f;
        s.addSound(snd);
        s.addSound(snd);  // second identical zone
        s.noteOn(60, 0);
        AudioBuffer out = renderAll(s, FRAMES + 1000);
        const float peak = peakInRange(out, 200, FRAMES - 200);
        checkNear(peak, 2.0f * std::pow(10.0f, -5.0f / 20.0f), 0.08, "two layered voices != 2x gain");
    }

    if (failures == 0) std::printf("sampler_test: OK\n");
    else std::printf("sampler_test: %d FAILURE(S)\n", failures);
    return failures == 0 ? 0 : 1;
}
