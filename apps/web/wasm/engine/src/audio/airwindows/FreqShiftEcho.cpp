// FreqShiftEcho — a from-scratch frequency-shifting echo replacing the proprietary
// ValhallaFreqEcho (so the native JUCE engine can drop the Valhalla VST + the
// Wine/yabridge dependency, with exact JUCE↔WASM parity since it's the same DSP).
//
// The Valhalla preset state turned out to be decodable FXB-wrapped XML, so this is
// parameterised to MATCH it 1:1 (params come decoded from PresetManager.h):
//   wetDryMix, shift (0.5 = 0 Hz), feedback, sync (note division), lowCut, highCut.
//
// Signal model (per channel): the frequency shifter + tone filters live INSIDE the
// delay feedback loop (so each repeat is shifted again and progressively darkened —
// the Valhalla shimmer):
//   delayed  = delayLine.read(delaySamples)
//   shifted  = freqShift(delayed, shiftHz)          // SSB via FIR Hilbert
//   toned    = highCutLP(lowCutHP(shifted))          // feedback tone (lowCut/highCut)
//   delayLine.write(input + feedback * toned)
//   wet      = toned
// Frequency shift = analytic signal (FIR Hilbert) then SSB: I·cosφ − Q·sinφ. The
// long Blackman-Harris FIR gives deep image rejection (no 2·shift-Hz beating); its
// group delay is COMPENSATED out of the delay length so loop timing matches Valhalla.
#include "AwPlugins.h"

#include <cmath>
#include <stdexcept>
#include <vector>

namespace casperaki {
namespace aw {
namespace {

constexpr double kPi = 3.14159265358979323846;

// FIR Hilbert transformer: Q = 90°-shifted signal, I = input delayed by the centre
// tap (group delay C). Long + Blackman-Harris -> deep single-sideband rejection.
struct Hilbert {
    static constexpr int L = 199, C = 99;
    double h[L], ring[L];
    int pos = 0;
    Hilbert() {
        for (int j = 0; j < L; ++j) {
            const int k = j - C;
            const double v = (k == 0 || (k & 1) == 0) ? 0.0 : 2.0 / (kPi * k);
            const double t = 2.0 * kPi * j / (L - 1);
            const double w = 0.35875 - 0.48829 * std::cos(t) + 0.14128 * std::cos(2 * t)
                                     - 0.01168 * std::cos(3 * t);   // Blackman-Harris
            h[j] = v * w;
        }
        reset();
    }
    void reset() { for (int i = 0; i < L; ++i) ring[i] = 0; pos = 0; }
    void process(double x, double& I, double& Q) {
        ring[pos] = x;
        double q = 0; int idx = pos;
        for (int j = 0; j < L; ++j) { q += h[j] * ring[idx]; if (--idx < 0) idx += L; }
        int ci = pos - C; if (ci < 0) ci += L;
        I = ring[ci]; Q = q;
        if (++pos >= L) pos = 0;
    }
};

// One-pole low-pass (a = 1-e^{-2πfc/sr}); high-pass = input - low-pass.
struct OnePole {
    double y = 0, a = 1.0;
    void setCutoff(double fc, double sr) { a = 1.0 - std::exp(-2.0 * kPi * fc / sr); if (a > 1) a = 1; if (a < 0) a = 0; }
    double lp(double x) { y += a * (x - y); return y; }
    void reset() { y = 0; }
};

struct Channel {
    Hilbert hb;
    OnePole loCut, hiCut;   // loCut used as HP (x - lp), hiCut as LP
    std::vector<float> delay;
    int wpos = 0, delaySamp = 11025;
    double phase = 0, shiftHz = 0, fbk = 0, sr = 44100;

    void init(double sampleRate) {
        sr = sampleRate;
        delay.assign((int)(sr * 4.0) + 4, 0.0f);
        wpos = 0; phase = 0; hb.reset(); loCut.reset(); hiCut.reset();
    }
    float process(float in) {
        int rpos = wpos - delaySamp; while (rpos < 0) rpos += (int)delay.size();
        const double delayed = delay[(size_t)rpos];

        double I, Q; hb.process(delayed, I, Q);
        double shifted = I * std::cos(phase) - Q * std::sin(phase);
        phase += 2.0 * kPi * shiftHz / sr;
        if (phase > 2.0 * kPi) phase -= 2.0 * kPi; else if (phase < 0) phase += 2.0 * kPi;

        const double afterHP = shifted - loCut.lp(shifted);   // lowCut (high-pass)
        const double toned = hiCut.lp(afterHP);               // highCut (low-pass)

        delay[(size_t)wpos] = (float)((double)in + fbk * toned);
        if (++wpos >= (int)delay.size()) wpos = 0;
        return (float)toned;
    }
};

// Map a normalised [0,1] cutoff knob to Hz over a log range.
static double cutoffHz(double v, double lo, double hi) { return lo * std::pow(hi / lo, v); }

// shift knob -> Hz (0.5 = 0 Hz, ±10 Hz).
static double shiftHzOf(double shiftKnob) { return (shiftKnob - 0.5) * 20.0; }

struct FreqShiftEchoImpl : Plugin {
    Channel L, R;
    double sr = 44100, secPerBeat = 0.5;
    // Valhalla-named params (defaults = the decoded preset).
    float wetDryMix = 1.0f, shift = 0.6441f, feedback = 0.348f, sync = 0.2174f,
          lowCut = 0.092f, highCut = 0.3311f;
    bool inited = false;

    int  numParams() const override { return 6; }
    // Allocate the delay lines here (build time), not on the first audio block.
    void setSampleRate(double s) override { sr = s; L.init(sr); R.init(sr); inited = true; }
    void setTransport(double spb, double) override { secPerBeat = spb; }
    // The frequency shifter's oscillator phase advances 2*pi*shiftHz/sr per sample
    // from 0: put it where a render from the start would have it at songSample.
    void seek(long long songSample) override {
        const double cycles = shiftHzOf(shift) * (double)songSample / sr;
        const double ph = 2.0 * kPi * (cycles - std::floor(cycles));
        L.phase = ph;
        R.phase = ph;
    }
    void setParam(int i, float v) override {
        switch (i) {
            case 0: wetDryMix = v; break;
            case 1: shift = v;     break;
            case 2: feedback = v;  break;
            case 3: sync = v;      break;
            case 4: lowCut = v;    break;
            case 5: highCut = v;   break;
        }
    }
    void process(float* const* in, float* const* out, int n) override {
        if (!inited) throw std::logic_error("FreqShiftEcho: process before setSampleRate");

        // The XML shift value is a UI knob, not a direct Hz value. Keep this very
        // gentle: the reference reads more like a faint FreqEcho color than an
        // obviously retuned delay note.
        const double shiftHz = shiftHzOf(shift);        // ±10 Hz; 0.6441 -> +2.9 Hz
        // sync -> delay. Valhalla's exact sync table is unknown; the decoded 0.2174
        // lands one beat later than the previous 1-beat mapping in the reference
        // render, so treat this preset as a 2-beat (1/2-note) echo.
        double beats = 0.5 + sync * 7.0;                // 0.2174 -> ~2.02 beats (1/2 note)
        int ds = (int)(beats * secPerBeat * sr) - Hilbert::C;   // compensate Hilbert loop latency
        if (ds < 1) ds = 1;
        const double hpHz = cutoffHz(lowCut, 20.0, 2000.0);     // lowCut 0.092 -> ~30 Hz
        const double lpHz = cutoffHz(highCut, 200.0, 18000.0);  // highCut 0.3311 -> ~920 Hz (dark repeats)

        // Valhalla's XML stores the feedback knob value, not necessarily the raw
        // delay-loop coefficient. Compress it hard so the shifted repeat does not
        // keep a jittery recirculating tail after the audible echo.
        const double loopFeedback = feedback * feedback * feedback;
        for (Channel* c : {&L, &R}) {
            c->delaySamp = ds; c->shiftHz = shiftHz; c->fbk = loopFeedback;
            c->loCut.setCutoff(hpHz, sr); c->hiCut.setCutoff(lpHz, sr);
        }
        // The delay return is fed a full-level (0 dB) send, so the raw echo comes back
        // ~as loud as the dry note and fills the gaps. Valhalla's echo sits ~14 dB
        // lower for the same send (its gaps stay at -45 dB vs our -32). Calibrate the
        // wet output down to match (kWetCal ≈ -14 dB). Tunable by ear.
        constexpr double kWetCal = 0.2;
        for (int i = 0; i < n; ++i) {
            out[0][i] = (float)(wetDryMix * kWetCal * L.process(in[0][i]));
            out[1][i] = (float)(wetDryMix * kWetCal * R.process(in[1][i]));
        }
    }
};

} // namespace

std::unique_ptr<Plugin> makeFreqShiftEcho() { return std::make_unique<FreqShiftEchoImpl>(); }

} // namespace aw
} // namespace casperaki
