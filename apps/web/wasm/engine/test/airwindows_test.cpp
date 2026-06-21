// Scope C de-risk + coverage: every vendored in-tree AirWindows plugin compiles
// portably (via aw_shim.h, no JUCE/VST SDK) and processes audio without producing
// NaN/Inf or blowing up. Each is fed a 440 Hz sine with mid (0.5) params. Exact
// native parity comes later (with the real decoded rack state); this locks the
// compile + run path for all 10 plugins the FX graph is built from.
#include "../src/audio/airwindows/AwPlugins.h"
#include "../src/audio/airwindows/AwStateDecode.h"

#include <cmath>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

using casperaki::aw::Plugin;

static int checkPlugin(const char* name, std::unique_ptr<Plugin> fx) {
    fx->setSampleRate(44100.0);
    for (int i = 0; i < fx->numParams(); ++i) fx->setParam(i, 0.5f);

    const int N = 2048;
    std::vector<float> l(N), r(N);
    for (int i = 0; i < N; ++i)
        l[i] = r[i] = 0.5f * std::sin(2.0f * 3.14159265f * 440.0f * i / 44100.0f);

    float* in[2]  = { l.data(), r.data() };
    float* out[2] = { l.data(), r.data() };
    // Two blocks so any internal delay/reverb state advances past the warm-up.
    fx->process(in, out, N / 2);
    in[0] = l.data() + N / 2; in[1] = r.data() + N / 2;
    out[0] = l.data() + N / 2; out[1] = r.data() + N / 2;
    fx->process(in, out, N / 2);

    bool finite = true;
    double peak = 0.0, sum2 = 0.0;
    for (int i = 0; i < N; ++i) {
        if (!std::isfinite(l[i]) || !std::isfinite(r[i])) finite = false;
        peak = std::max(peak, (double)std::fabs(l[i]));
        sum2 += (double)l[i] * l[i];
    }
    const double rms = std::sqrt(sum2 / N);
    std::printf("  %-16s params=%d peak=%.4f rms=%.4f  %s\n",
                name, fx->numParams(), peak, rms,
                (finite && peak <= 10.0) ? "ok" : "FAIL");
    return (finite && peak <= 10.0) ? 0 : 1;
}

static int checkStateDecode() {
    // The real percussion-rack TexturizeMS chunk (PresetManager.h) must decode to
    // the same params the validated JS tool reports: [0.5, 1, 0.5, 1, 0.5, 0.5].
    const std::string tx =
        "184.CMlaKA....fQBMDZ....APWY3UG...P.....................................................................................................................................................................................X....7C...3O....+....9C...vO....+.";
    const std::vector<float> expect = {0.5f, 1.0f, 0.5f, 1.0f, 0.5f, 0.5f};
    const std::vector<float> got = casperaki::aw::decodeAwParams(tx);
    bool ok = got.size() == expect.size();
    for (size_t i = 0; ok && i < got.size(); ++i) ok = std::fabs(got[i] - expect[i]) < 1e-6f;
    std::printf("state-decode TexturizeMS: n=%zu [", got.size());
    for (float f : got) std::printf("%.3f ", f);
    std::printf("] %s\n", ok ? "ok" : "FAIL");
    return ok ? 0 : 1;
}

// SimpleSide pump: with the decoded synths params (mix .52, rate 2 beats, duck-to-0
// curve), a steady signal must be amplitude-MODULATED over the 2-beat cycle (ducked
// near the downbeat, full later) — that's the faux-sidechain pump.
static int checkSimpleSide() {
    auto fx = casperaki::aw::makeSimpleSide();
    // synths state: mix, rate, then (x,y,rawExp) curve points.
    const float p[] = {0.52f, 1.0f, 0.f,0.f,5.7f, 0.2876f,0.998f,0.f, 0.998f,1.f,0.f};
    for (int i = 0; i < (int)(sizeof(p)/sizeof(float)); ++i) fx->setParam(i, p[i]);
    fx->setSampleRate(44100.0);
    const double secPerBeat = 0.5;  // 120 bpm -> 2-beat cycle = 1.0 s
    // Sample the envelope at the downbeat (phase 0, ducked) vs mid-cycle (phase ~0.5, full).
    auto levelAt = [&](double tSec) {
        fx->setTransport(secPerBeat, tSec);
        float l[64], r[64]; for (int i=0;i<64;++i) l[i]=r[i]=0.5f;
        float* in[2]={l,r}; float* out[2]={l,r}; fx->process(in,out,64);
        return std::fabs(l[0]);
    };
    const double duck = levelAt(0.0);     // phase 0 -> curve y=0 -> scale 0 -> in*(1-mix)
    const double full = levelAt(0.5);     // phase 0.5 -> curve y=1 -> scale 1 -> in
    const double depthDb = 20.0 * std::log10(full / std::max(duck, 1e-9));
    std::printf("SimpleSide pump: duck=%.4f full=%.4f depth=%.2f dB  %s\n",
                duck, full, depthDb, depthDb > 3.0 ? "ok" : "FAIL");
    return depthDb > 3.0 ? 0 : 1;
}

// Single-frequency power (Goertzel).
static double goertzel(const float* x, int n, double freq, double sr) {
    const double w = 2.0 * 3.14159265358979323846 * freq / sr, coeff = 2.0 * std::cos(w);
    double s1 = 0, s2 = 0;
    for (int i = 0; i < n; ++i) { const double s0 = x[i] + coeff * s1 - s2; s2 = s1; s1 = s0; }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

// FreqShiftEcho: a 1 kHz tone shifted +10 Hz (top of the softened musical range)
// must come out as a CLEAN upper sideband at 1010 Hz — the 990 Hz image (bad
// quadrature) must be well down.
static int checkFreqShiftEcho() {
    auto fx = casperaki::aw::makeFreqShiftEcho();
    fx->setSampleRate(44100.0);
    fx->setParam(0, 1.0f);   // wetDryMix
    fx->setParam(1, 1.0f);   // shift -> (1.0-0.5)*20 = +10 Hz
    fx->setParam(2, 0.0f);   // feedback off (single pass)
    fx->setParam(3, 0.0f);   // sync -> short delay
    fx->setParam(4, 0.0f);   // lowCut (HP ~20 Hz, passes)
    fx->setParam(5, 1.0f);   // highCut (LP wide open, passes 1010 Hz)
    const int N = 44100;
    std::vector<float> l(N), r(N);
    for (int i = 0; i < N; ++i) l[i] = r[i] = std::sin(2.0 * 3.14159265 * 1000.0 * i / 44100.0);
    float* in[2] = { l.data(), r.data() }; float* out[2] = { l.data(), r.data() };
    fx->process(in, out, N);
    // Measure the settled second half of the L channel.
    const float* seg = l.data() + N / 2; const int M = N / 2;
    const double up = goertzel(seg, M, 1010.0, 44100.0);
    const double img = goertzel(seg, M, 990.0, 44100.0);
    const double rej = 10.0 * std::log10((up + 1e-12) / (img + 1e-12));
    bool finite = true; for (int i = 0; i < M; ++i) if (!std::isfinite(seg[i])) finite = false;
    std::printf("FreqShiftEcho: +10Hz shift  1010Hz/990Hz = %.1f dB sideband rejection  %s\n",
                rej, (finite && rej > 12.0) ? "ok" : "FAIL");
    return (finite && rej > 12.0) ? 0 : 1;
}

int main() {
    using namespace casperaki::aw;
    int fails = 0;
    std::printf("AirWindows state-chunk decode:\n");
    fails += checkStateDecode();
    fails += checkSimpleSide();
    fails += checkFreqShiftEcho();
    std::printf("AirWindows in-tree port smoke (10 plugins):\n");
    fails += checkPlugin("Console8SubIn",  makeConsole8SubIn());
    fails += checkPlugin("Console8SubOut", makeConsole8SubOut());
    fails += checkPlugin("Console8BussIn", makeConsole8BussIn());
    fails += checkPlugin("Console8BussOut",makeConsole8BussOut());
    fails += checkPlugin("Air2",           makeAir2());
    fails += checkPlugin("Huge",           makeHuge());
    fails += checkPlugin("StereoChorus",   makeStereoChorus());
    fails += checkPlugin("TexturizeMS",    makeTexturizeMS());
    fails += checkPlugin("kPlateA",        makeKPlateA());
    fails += checkPlugin("kPlateD",        makeKPlateD());
    std::printf("AirWindows Tracktion-bundled (6 plugins):\n");
    fails += checkPlugin("Pyewacket",      makePyewacket());
    fails += checkPlugin("EQ",             makeEQ());
    fails += checkPlugin("Logical4",       makeLogical4());
    fails += checkPlugin("NC-17",          makeNC17());
    fails += checkPlugin("Thunder",        makeThunder());
    fails += checkPlugin("ADClip7",        makeADClip7());
    std::printf("%s (%d failures)\n", fails == 0 ? "PASS" : "FAIL", fails);
    return fails == 0 ? 0 : 1;
}
