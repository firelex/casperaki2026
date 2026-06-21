// The two non-AirWindows FX in the rack graph, which have no usable source and
// so are bespoke best-effort reimplementations (docs/63 §6):
//
//   - SimpleSide (GPLv3, KottV) — a tempo-synced volume/pan "pumping"
//     (faux-sidechain) on the synths + leadSynths submixes. Must be reimplemented
//     from behaviour, not lifted (copyleft). Its state is the standard AirWindows
//     FXB format (212 bytes = 160 + 13 floats) so params ARE decodable, but the
//     param semantics need reverse-engineering from the plugin's behaviour.
//   - ValhallaFreqEcho (proprietary, no source) — a frequency-shifting echo on
//     the fxStereoDelay return. Its state (454 bytes) is NOT the AirWindows FXB
//     format ((454-160)/4 is non-integer), so even the params are opaque; this is
//     a genuine black box → bespoke freq-shift echo, exact parity not achievable.
//
// REGISTERED HERE AS PASSTHROUGH PLACEHOLDERS so the Scope B rack graph can wire
// the full chains today; the real pumping LFO / freq-shift-echo DSP is the
// remaining Scope C work. Passthrough = signal preserved, effect absent.
#include "AwPlugins.h"

namespace casperaki {
namespace aw {
namespace {

struct Passthrough : Plugin {
    int nParams;
    explicit Passthrough(int n) : nParams(n) {}
    int  numParams() const override { return nParams; }
    void setSampleRate(double) override {}
    void setParam(int, float) override {}
    void process(float* const* in, float* const* out, int frames) override {
        // Copy in -> out per channel (handles aliasing where in==out for free).
        for (int ch = 0; ch < 2; ++ch)
            if (in[ch] != out[ch])
                for (int i = 0; i < frames; ++i) out[ch][i] = in[ch][i];
    }
};

struct Silence : Plugin {
    int  numParams() const override { return 0; }
    void setSampleRate(double) override {}
    void setParam(int, float) override {}
    void process(float* const* /*in*/, float* const* out, int frames) override {
        for (int ch = 0; ch < 2; ++ch)
            for (int i = 0; i < frames; ++i) out[ch][i] = 0.0f;
    }
};

} // namespace

// makeSimpleSide() now lives in SimpleSide.cpp (a real tempo-synced pump).

// ValhallaFreqEcho (proprietary, no source) is SUBSTITUTED by AirWindows TapeDelay
// on the delay return (see the rack factory map). This Silence remains only as a
// fallback if a build ever routes the literal Valhalla factory — passthrough would
// double the dry delay-send into master, so Silence is the safe no-op.
std::unique_ptr<Plugin> makeValhallaFreqEcho() { return std::make_unique<Silence>(); }

} // namespace aw
} // namespace casperaki
