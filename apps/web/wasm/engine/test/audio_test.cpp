// Unit test for the sampler DSP primitives (docs/60 Phase 1 sampler half).
// The audio half's oracle is structural/synthetic, not a WAV null against the
// golden (out.wav was rendered with stub samples + silent VST tonal lanes + FX
// — see memory wasm-engine-phase1-sampler). So we assert the resampler and gain
// math against analytic expectations:
//   (1) gain-chain collapse — sampledNoteGains == dbToGain(gainDb - 5) at vel
//       0.75, pan 0, both channels (the fader/pan dance is identity).
//   (2) unity-ratio passthrough — Lagrange at ratio 1.0 reproduces a smooth
//       input after its 2-sample latency (DC and a slow sine).
//   (3) octave-up pitch — ratio 2.0 doubles the frequency (zero-cross count).
//   (4) processAdding accumulates gain*result onto existing output.

#include "../src/audio/Gain.h"
#include "../src/audio/Interpolator.h"
#include "../src/audio/AudioDecode.h"
#include "../src/audio/Mixer.h"

#include <cmath>
#include <cstring>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

using casperaki::LagrangeInterpolator;

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

float dbToGain(float db) { return std::pow(10.0f, db / 20.0f); }

std::shared_ptr<casperaki::SampleData> makeMonoSample(std::initializer_list<float> xs, int sr) {
    auto data = std::make_shared<casperaki::SampleData>();
    data->frames = (int)xs.size();
    data->sampleRate = sr;
    data->audio.setSize(1, data->frames + 8);
    int i = 0;
    for (float x : xs) data->audio.getWritePointer(0)[i++] = x;
    return data;
}

std::vector<float> renderWaveClip(bool loop) {
    constexpr double sr = 10.0;
    auto sample = makeMonoSample({1.0f, 2.0f, 3.0f}, (int)sr);

    casperaki::ResolvedEvents ev;
    ev.lengthSec = 0.5;
    ev.secPerBeat = 0.5;
    casperaki::Track track;
    track.name = loop ? "Percussion Loop" : "Sample Transitions FX";
    casperaki::Clip clip;
    clip.name = "test";
    clip.type = "wave";
    clip.startSec = 0.0;
    clip.endSec = 0.5;
    clip.source = "wave.ogg";
    clip.loop = loop;
    track.clips.push_back(std::move(clip));
    ev.tracks.push_back(std::move(track));

    casperaki::StubSamples stubs;
    stubs.tone = sample;
    casperaki::Mixer mixer(sr, 8, 0.0, stubs);
    mixer.setSample("wave.ogg", sample);
    mixer.build(ev, {});

    casperaki::AudioBuffer out(2, 8);
    mixer.pullBlock(out, 5);
    return std::vector<float>(out.getReadPointer(0), out.getReadPointer(0) + 5);
}

// Count sign changes (zero crossings) in a signal — a coarse frequency proxy.
int zeroCrossings(const std::vector<float>& x) {
    int c = 0;
    for (size_t i = 1; i < x.size(); ++i)
        if ((x[i - 1] <= 0.0f && x[i] > 0.0f) || (x[i - 1] >= 0.0f && x[i] < 0.0f)) ++c;
    return c;
}

} // namespace

int main() {
    // (0) MP3 gapless metadata: parse the 12-bit LAME encoder delay + padding
    //     values from the first frame's Xing/Info tag. This is what keeps raw
    //     minimp3 frame decode aligned with ffmpeg-normalised OGG prestage.
    {
        std::string mp3(160, '\0');
        auto* b = reinterpret_cast<unsigned char*>(mp3.data());
        // MPEG1 Layer III, stereo: Xing/Info starts at frame + 4 + 32.
        b[0] = 0xff; b[1] = 0xfb; b[2] = 0x90; b[3] = 0x00;
        const int xing = 4 + 32;
        std::memcpy(b + xing, "Xing", 4);
        const int leading = 1152, trailing = 576;
        const int dp = xing + 0x24 + 0x15;
        b[dp] = (unsigned char)(leading >> 4);
        b[dp + 1] = (unsigned char)(((leading & 0x0f) << 4) | (trailing >> 8));
        b[dp + 2] = (unsigned char)(trailing & 0xff);
        const auto trim = casperaki::readMp3GaplessTrim(mp3);
        check(trim.leading == leading, "MP3 Xing/LAME leading delay parse failed");
        check(trim.trailing == trailing, "MP3 Xing/LAME trailing padding parse failed");

        std::string noTag(64, '\0');
        auto* n = reinterpret_cast<unsigned char*>(noTag.data());
        n[0] = 0xff; n[1] = 0xfb; n[2] = 0x90; n[3] = 0x00;
        const auto noTrim = casperaki::readMp3GaplessTrim(noTag);
        check(noTrim.leading == 0 && noTrim.trailing == 0, "MP3 without Xing/LAME should not trim");
    }

    // (1) Gain-chain collapse: the two-step fader mapping + linear pan law at
    //     velocity 0.75 / pan 0 must equal a plain dB→gain of (gainDb - 5).
    for (float db : {-12.0f, -6.0f, 0.0f, 3.0f, 6.0f}) {
        float l = 0, r = 0;
        casperaki::sampledNoteGains(db, 0.75f, 0.0f, l, r);
        const float expect = dbToGain(db - 5.0f); // 20*(1-0.75) = 5 dB
        checkNear(l, expect, 1e-4, "left gain != dbToGain(db-5)");
        checkNear(r, expect, 1e-4, "right gain != dbToGain(db-5)");
        checkNear(l, r, 1e-6, "pan 0 should give equal L/R");
    }

    // (2a) Unity ratio, DC input: after latency the output tracks 1.0.
    {
        LagrangeInterpolator interp;
        std::vector<float> in(64, 1.0f), out(64, 0.0f);
        interp.processAdding(1.0, in.data(), out.data(), 60, 1.0f);
        // Allow the 2-sample Lagrange latency to settle, then expect ~1.0.
        for (int i = 4; i < 60; ++i) checkNear(out[i], 1.0f, 1e-4, "unity-ratio DC not passed through");
    }

    // (2b) Unity ratio, slow sine: output should match a 2-sample-delayed input
    //      closely (interpolation error tiny for a well-oversampled sine).
    {
        LagrangeInterpolator interp;
        const int N = 512;
        std::vector<float> in(N), out(N, 0.0f);
        const double w = 2.0 * M_PI / 64.0; // 64 samples/cycle
        for (int i = 0; i < N; ++i) in[i] = static_cast<float>(std::sin(w * i));
        interp.processAdding(1.0, in.data(), out.data(), N - 4, 1.0f);
        double maxErr = 0.0;
        for (int i = 8; i < N - 8; ++i)
            maxErr = std::max(maxErr, (double)std::fabs(out[i] - in[i - 2])); // ~2-sample latency
        check(maxErr < 0.02, "unity-ratio sine error too large");
    }

    // (3) Octave up: resampling a sine at ratio 2.0 halves the output length and
    //     preserves the cycle count — so zero crossings over the produced span
    //     stay ~equal to the input's crossings consumed (freq doubles, span halves).
    {
        LagrangeInterpolator interp;
        const int IN = 2048;
        std::vector<float> in(IN);
        const double w = 2.0 * M_PI / 32.0; // 32 samples/cycle -> 64 cycles in 2048
        for (int i = 0; i < IN; ++i) in[i] = static_cast<float>(std::sin(w * i));
        const int OUT = 1000; // consumes ~2000 input samples at ratio 2.0
        std::vector<float> out(OUT, 0.0f);
        int used = interp.processAdding(2.0, in.data(), out.data(), OUT, 1.0f);
        check(used >= 1990 && used <= 2002, "ratio 2.0 consumed wrong input count");
        // Output period = 32/2 = 16 samples/cycle -> 1000/16 = 62.5 cycles ->
        // ~125 zero crossings (2 per cycle).
        const int zc = zeroCrossings(out);
        check(zc >= 118 && zc <= 132, "octave-up crossing count off");
    }

    // (4) processAdding accumulates: pre-fill output, add gain*signal on top.
    {
        LagrangeInterpolator interp;
        std::vector<float> in(64, 1.0f), out(64, 0.5f);
        interp.processAdding(1.0, in.data(), out.data(), 60, 2.0f);
        for (int i = 8; i < 60; ++i) checkNear(out[i], 0.5f + 2.0f, 1e-4, "processAdding did not accumulate gain*signal");
    }

    // (5) Wave clips: loops tile across the clip, while one-shots stop at the
    //     decoded sample length instead of wrapping their attack transient.
    {
        const auto oneShot = renderWaveClip(false);
        const float expectOneShot[] = {1.0f, 2.0f, 3.0f, 0.0f, 0.0f};
        for (int i = 0; i < 5; ++i)
            checkNear(oneShot[(size_t)i], expectOneShot[i], 1e-6, "one-shot wave clip wrapped past sample end");

        const auto loop = renderWaveClip(true);
        const float expectLoop[] = {1.0f, 2.0f, 3.0f, 1.0f, 2.0f};
        for (int i = 0; i < 5; ++i)
            checkNear(loop[(size_t)i], expectLoop[i], 1e-6, "loop wave clip did not tile");
    }

    if (failures == 0) std::printf("audio_test: OK\n");
    else std::printf("audio_test: %d FAILURE(S)\n", failures);
    return failures == 0 ? 0 : 1;
}
