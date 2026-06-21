// docs/62 A7 — unit test for the transitionNoise (fxNoiseRise) audio source.
//
// Drives the Mixer's flat path (mixEnabled=false) with a single NoiseRise and
// asserts the synthesized white-noise riser is correct: silent outside the
// window, audible inside, a rise-then-fall dB envelope, an opening LP filter
// sweep (more HF energy late than early), and bit-exact determinism run-to-run.

#include "../src/audio/Mixer.h"
#include "../src/Resolver.h"

#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

namespace {
int failures = 0;
void check(bool cond, const char* msg) {
    if (!cond) { std::printf("FAIL: %s\n", msg); ++failures; }
}

// Render the whole song's left channel into one vector (flat path).
std::vector<float> renderNoise(const casperaki::ResolvedEvents& ev, double sr, int block) {
    casperaki::StubSamples stubs;
    casperaki::Mixer mixer(sr, block, 0.0, stubs);
    mixer.setMixEnabled(false);   // flat path — raw lane sum, no graph coloring
    mixer.build(ev, {});
    std::vector<float> out;
    casperaki::AudioBuffer buf(2, block);
    bool more = true;
    while (more) {
        more = mixer.pullBlock(buf, block);
        const float* l = buf.getReadPointer(0);
        for (int i = 0; i < block; ++i) out.push_back(l[i]);
    }
    return out;
}

double rmsWindow(const std::vector<float>& x, long lo, long hi) {
    double acc = 0; long n = 0;
    for (long i = lo; i < hi && i < (long)x.size(); ++i) { acc += (double)x[i] * x[i]; ++n; }
    return n ? std::sqrt(acc / n) : 0.0;
}
long zeroCross(const std::vector<float>& x, long lo, long hi) {
    long c = 0;
    for (long i = lo + 1; i < hi && i < (long)x.size(); ++i)
        if ((x[i - 1] <= 0 && x[i] > 0) || (x[i - 1] >= 0 && x[i] < 0)) ++c;
    return c;
}

casperaki::ResolvedEvents makeEv() {
    casperaki::ResolvedEvents ev;
    ev.genre = "edm";
    ev.lengthSec = 7.0;
    ev.secPerBeat = 0.5;
    casperaki::NoiseRise nr;
    nr.startSec = 2.0;
    nr.attackDuration = 2.0;     // rise 2s -> 4s
    nr.decayOffset = 2.0;        // decay begins at +2s (== attack end)
    nr.decayDuration = 1.0;      // fall 4s -> 5s
    nr.freqStart = 100; nr.freqEnd = 20000;
    nr.volAttack = -30; nr.volSustain = -20; nr.volDecay = -50;
    ev.noiseRises.push_back(nr);
    return ev;
}
} // namespace

int main() {
    constexpr double sr = 44100.0;
    constexpr int block = 128;
    const auto ev = makeEv();
    const auto x = renderNoise(ev, sr, block);

    const long sStart = (long)std::llround(2.0 * sr);
    const long sAttackEnd = (long)std::llround(4.0 * sr);
    const long sEnd = (long)std::llround(5.0 * sr);

    // (1) silent before the window and (2) after it.
    check(rmsWindow(x, (long)(1.0 * sr), (long)(1.9 * sr)) < 1e-7, "noise leaked BEFORE the window");
    check(rmsWindow(x, (long)(5.2 * sr), (long)(6.5 * sr)) < 1e-7, "noise leaked AFTER the window");

    // (3) audible inside the window.
    const double midRms = rmsWindow(x, (long)(3.5 * sr), (long)(3.9 * sr));
    check(midRms > 1e-4, "no audible noise inside the window");

    // (4) rise-then-fall envelope: early attack quieter than the sustain peak,
    //     and late decay quieter than the peak.
    const double earlyRms = rmsWindow(x, sStart + 100, (long)(2.4 * sr));
    const double peakRms = rmsWindow(x, (long)(3.7 * sr), sAttackEnd);
    const double lateRms = rmsWindow(x, (long)(4.7 * sr), sEnd - 100);
    check(peakRms > earlyRms * 1.5, "envelope did not rise across the attack");
    check(peakRms > lateRms * 1.5, "envelope did not fall across the decay");

    // (5) LP cutoff sweep opens: more zero-crossings (HF energy) late than early.
    const long zcEarly = zeroCross(x, sStart + 200, (long)(2.3 * sr));
    const long zcLate = zeroCross(x, (long)(3.6 * sr), (long)(3.9 * sr));
    check(zcLate > zcEarly, "LP cutoff sweep did not open (no extra HF late)");

    // (6) decorrelated stereo: the legacy 4OSC runs an independent Gaussian noise
    //     generator per channel, so L and R must differ inside the window.
    {
        casperaki::StubSamples stubs;
        casperaki::Mixer mixer(sr, block, 0.0, stubs);
        mixer.setMixEnabled(false);
        mixer.build(ev, {});
        casperaki::AudioBuffer buf(2, block);
        std::vector<float> L, R;
        bool more = true;
        while (more) {
            more = mixer.pullBlock(buf, block);
            const float* l = buf.getReadPointer(0);
            const float* r = buf.getReadPointer(1);
            for (int i = 0; i < block; ++i) { L.push_back(l[i]); R.push_back(r[i]); }
        }
        double diff = 0;
        for (long i = sStart + 100; i < sAttackEnd && i < (long)L.size(); ++i) diff += std::fabs(L[i] - R[i]);
        check(diff > 1e-3, "stereo channels are identical (noise not decorrelated)");
    }

    // (7) determinism: a second render is bit-identical.
    const auto y = renderNoise(ev, sr, block);
    bool identical = x.size() == y.size();
    for (size_t i = 0; identical && i < x.size(); ++i) if (x[i] != y[i]) identical = false;
    check(identical, "noise render is not deterministic");

    // (8) Resolver: an adapter-expanded fxNoiseRise transition block becomes a
    //     NoiseRise at the right absolute time. chorus1 starts after verse1's 8
    //     bars = 8*4*secPerBeat = 16s @120bpm; ssp=0 -> startSec == segStart.
    {
        const char* song = R"JSON({
          "tempo": 120,
          "structure": [
            {"segment":"verse1","bars":[{},{},{},{},{},{},{},{}]},
            {"segment":"chorus1","bars":[{},{},{},{},{},{},{},{}]}
          ],
          "arrangement": {
            "verse1": { "transitions": { "fxNoiseRise": {
              "type":"fxNoiseRise","sequenceStartPosition":0,
              "sequenceStartPositionOffsetInSeconds":0,
              "attackDuration":16.0,"decaySequenceStartPositionOffsetInSeconds":16.0,
              "decayDuration":6.0,"frequencyStart":100,"frequencyEnd":20000,
              "volumeAttack":-30,"volumeSustain":-20,"volumeDecay":-50 } } }
          }
        })JSON";
        casperaki::Resolver resolver;
        casperaki::ResolvedEvents rev = resolver.resolve(song, {});
        check(rev.noiseRises.size() == 1, "resolver did not produce exactly one NoiseRise");
        if (rev.noiseRises.size() == 1) {
            const auto& nr = rev.noiseRises[0];
            check(std::fabs(nr.startSec - 0.0) < 1e-9, "verse1 riser startSec should be 0");
            check(std::fabs(nr.attackDuration - 16.0) < 1e-9, "attackDuration mismatch");
            check(std::fabs(nr.decayDuration - 6.0) < 1e-9, "decayDuration mismatch");
            check(nr.freqStart == 100 && nr.freqEnd == 20000, "freq range mismatch");
            check(nr.volAttack == -30 && nr.volSustain == -20 && nr.volDecay == -50, "vol envelope mismatch");
        }
    }

    if (failures == 0) std::printf("noise_source_test: OK\n");
    return failures == 0 ? 0 : 1;
}
