// FreqShiftEcho — a from-scratch frequency-shifting echo replacing the proprietary
// ValhallaFreqEcho (so the native JUCE engine can drop the Valhalla VST + the
// Wine/yabridge dependency, with exact JUCE↔WASM parity since it's the same DSP).
//
// Params come decoded 1:1 from the Valhalla preset XML (PresetManager.h):
//   [wetDryMix, shift, feedback, sync, lowCut, highCut]
// (Valhalla's other attributes are not params here: `delay` — the free delay time,
// used only when sync is step 0-1 — and `stereo`, which every Casperaki preset sets to
// 1 = stereo. This implements stereo mode and delay = 0.)
//
// Every mapping and constant below was MEASURED from the real plugin (the Windows
// VST2 hosted offline through yabridge, preset chunk restored, tempo from the host;
// impulses, 440 Hz bursts and a lead-synth note at 120 and 98 bpm, plus knob sweeps).
// Valhalla's own parameter readouts gave the Hz mappings; the impulse/sine responses
// gave the structure, filter shapes, loop gain and saturation.
//
// Signal model (one mono loop, Valhalla stereo mode):
//   m       = (inL + inR) / 2                       // input is summed to mono
//   d       = delay.read(syncBeats * secPerBeat)    // tempo-synced, no smoothing
//   I, Q    = analytic signal of d (IIR allpass Hilbert pair)
//   upL     = I·cosφ − Q·sinφ    (shifted UP by shiftHz)
//   downR   = I·cosφ + Q·sinφ    (shifted DOWN by shiftHz)
//   yL, yR  = tone(upL), tone(downR)                 // tone = gain·HP·LP·HF rolloff
//   delay.write(m + 1.5·feedback · tanh(3.15·yL)/3.15)
//   out     = (1 − wet)·dry + wet·(yL, yR)
// So every repeat (including the first) is shifted once more and filtered once more;
// the left output is shifted up and the right down from the same loop (L/R are
// decorrelated, equal level), and the loop accumulates the UP shift.
// The delay line is read kHilbertComp samples early so the Hilbert pair's group delay
// (≈8 samples where the echo's energy sits, ~1-2 kHz) does not stretch each pass.
#include "AwPlugins.h"

#include <cmath>
#include <stdexcept>
#include <string>
#include <vector>

namespace casperaki {
namespace aw {
namespace {

constexpr double kPi = 3.14159265358979323846;

// IIR Hilbert pair (Olli Niemitalo's polyphase allpass design): two chains of four
// 2nd-order allpasses whose outputs stay 90° ± 0.7° apart from 20 Hz to 21.5 kHz at
// 44.1 kHz. A 199-tap FIR Hilbert (the first version) loses its 90° branch below
// ~400 Hz (−5 dB at 200 Hz), which left a low lead note's L/R nearly identical and
// ~2 dB quieter than Valhalla; the IIR pair works down to 20 Hz, as Valhalla's does.
// Both branches are allpass, so I is not the plain input: it carries the pair's
// dispersion (≈12 samples group delay at 1 kHz, ~116 at 100 Hz).
struct Hilbert {
    struct AP2 {   // y[n] = c·(x[n] + y[n−2]) − x[n−2]
        double c = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        double process(double x) { const double y = c * (x + y2) - x2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; }
        void reset() { x1 = x2 = y1 = y2 = 0; }
    };
    AP2 a[4], b[4];
    double qDelay = 0;   // the Q branch's extra one-sample delay
    Hilbert() {
        const double ka[4] = { 0.6923878, 0.9360654322959, 0.9882295226860, 0.9987488452737 };
        const double kb[4] = { 0.4021921162426, 0.8561710882420, 0.9722909545651, 0.9952884791278 };
        for (int i = 0; i < 4; ++i) { a[i].c = ka[i] * ka[i]; b[i].c = kb[i] * kb[i]; }
    }
    void reset() { for (int i = 0; i < 4; ++i) { a[i].reset(); b[i].reset(); } qDelay = 0; }
    void process(double x, double& I, double& Q) {
        double xi = x, xq = x;
        for (int i = 0; i < 4; ++i) { xi = b[i].process(xi); xq = a[i].process(xq); }
        I = xi; Q = qDelay; qDelay = xq;   // Q lags I by 90°
    }
};

// Valhalla's highCut: a one-pole low-pass, y += a(x − y), a = 1 − e^{−2πfc/sr}
// (its measured response matches this form to ±0.3 dB up to 14 kHz at 1.5 and 5 kHz).
struct OnePoleLP {
    double y = 0, a = 1.0;
    void setCutoff(double fc, double sr) { a = 1.0 - std::exp(-2.0 * kPi * fc / sr); }
    double process(double x) { y += a * (x - y); return y; }
    void reset() { y = 0; }
};

// Valhalla's lowCut: a one-pole high-pass, bilinear (no loss at high frequencies —
// this form fits the measured 294 Hz and 914 Hz settings better than x − lowpass).
struct OnePoleHP {
    double b = 1, a1 = 0, x1 = 0, y1 = 0;
    void setCutoff(double fc, double sr) {
        const double K = std::tan(kPi * fc / sr);
        b = 1.0 / (1.0 + K); a1 = (K - 1.0) / (K + 1.0);
    }
    double process(double x) { const double y = b * (x - x1) - a1 * y1; x1 = x; y1 = y; return y; }
    void reset() { x1 = y1 = 0; }
};

// A fixed, gentle high-frequency roll-off present in every Valhalla pass whatever the
// knobs (−1 dB at 8 kHz, −5 dB at 16 kHz on top of the highCut filter): fitted as an
// RBJ biquad low-pass, fc 19155 Hz, Q 0.3.
struct Biquad {
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    void setLowpass(double fc, double q, double sr) {
        const double w0 = 2.0 * kPi * fc / sr, al = std::sin(w0) / (2.0 * q), c = std::cos(w0);
        const double a0 = 1.0 + al;
        b0 = (1.0 - c) / 2.0 / a0; b1 = (1.0 - c) / a0; b2 = b0;
        a1 = -2.0 * c / a0; a2 = (1.0 - al) / a0;
    }
    double process(double x) {
        const double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y; return y;
    }
    void reset() { x1 = x2 = y1 = y2 = 0; }
};

// One output channel's tone stage (lowCut HP → highCut LP → fixed HF roll-off).
struct Tone {
    OnePoleHP hp; OnePoleLP lp; Biquad hf;
    double process(double x) { return hf.process(lp.process(hp.process(x))); }
    void reset() { hp.reset(); lp.reset(); hf.reset(); }
};

// Valhalla's sync menu, measured by sweeping the knob in 1/230 steps at 120 and 98 bpm:
// step = ceil(knob · 23) (each step covers (k−1, k], e.g. the preset's 0.2173913 =
// 4.9999998/23 is step 5 = 1/8 note, which the plugin plays); value = delay in quarter-
// note beats. Steps 0-1 = not synced (the free `delay` time). Then straight 1/64 … 2/1,
// dotted 1/64 … 1/1, triplet 1/64 … 1/1 — exactly as the plugin plays them, including
// its repeated 1/16T (steps 18 and 19; it has no 1/32T).
constexpr double kSyncBeats[24] = {
    0.0, 0.0,                                                     // 0-1: free (delay ms)
    0.0625, 0.125, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0,                 // 2-9: 1/64 … 2/1
    0.09375, 0.1875, 0.375, 0.75, 1.5, 3.0, 6.0,                  // 10-16: 1/64D … 1/1D
    1.0 / 24.0, 1.0 / 6.0, 1.0 / 6.0, 1.0 / 3.0, 2.0 / 3.0,       // 17-21: 1/64T, 1/16T, 1/16T, 1/8T, 1/4T
    4.0 / 3.0, 8.0 / 3.0,                                         // 22-23: 1/2T, 1/1T
};
constexpr double kFreeDelaySec = 0.00001;   // Valhalla's `delay` = 0.0 reads 0.01 ms

// Read-ahead that cancels the Hilbert pair's group delay per pass: fitted so the
// impulse-echo peaks and their spacing match Valhalla's (−0.1 / −0.2 ms first-echo
// offset, 250.05 / 306.13 ms spacing at 120 / 98 bpm).
constexpr long kHilbertComp = 8;

// The longest delay the line holds: 8 beats (2/1) at 40 bpm.
constexpr double kMaxDelaySec = 12.0;

// shift knob -> Hz, read off Valhalla's display: ±1000 Hz, fifth-power taper
// (0.5 = 0 Hz; the preset's 0.6441 -> +1.99 Hz, measured +1.99 Hz per repeat).
static double shiftHzOf(double v) {
    const double x = 2.0 * (v - 0.5);
    return (x < 0 ? -1.0 : 1.0) * 1000.0 * std::pow(std::fabs(x), 5.0);
}

// Loop gain per pass = 1.5 × feedback knob (measured 0.1 … 0.348 at low level: the
// steady repeat-to-repeat decay at 440 Hz with the filters open is 1.50·fb × filters).
constexpr double kFeedbackScale = 1.5;
// The feedback path saturates: tanh(k·y)/k on the echo before the feedback gain.
// k fitted from 440 Hz bursts at 0.16 … 1.0 peak and feedback 0.348 / 0.6 / 0.8
// (repeat levels within ±0.35 dB; the plugin's repeat 2 of a 0 dBFS burst is 7 dB
// down from linear, with a −13 dB 3rd harmonic).
constexpr double kSatK = 3.15;
// Broadband gain of one pass: the measured preset echo (lowCut 294 Hz, highCut 5 kHz)
// sits +0.2 dB above the bare filter product. (Other filter settings measured
// −0.6 … +0.5 dB; the preset is matched exactly.)
const double kPassGain = std::pow(10.0, 0.2 / 20.0);

struct FreqShiftEchoImpl : Plugin {
    Hilbert hb;
    Tone toneL, toneR;
    std::vector<float> delay;
    int wpos = 0;
    double phase = 0;
    double sr = 44100, secPerBeat = 0.5;
    // Valhalla-named params (defaults = the decoded preset).
    float wetDryMix = 1.0f, shift = 0.6441f, feedback = 0.348f, sync = 0.2174f,
          lowCut = 0.092f, highCut = 0.3311f;
    bool inited = false;

    int  numParams() const override { return 6; }
    // Allocate the delay line here (build time), not on the first audio block.
    void setSampleRate(double s) override {
        sr = s;
        delay.assign((size_t)(sr * kMaxDelaySec) + 4, 0.0f);
        wpos = 0; phase = 0; hb.reset(); toneL.reset(); toneR.reset();
        inited = true;
    }
    void setTransport(double spb, double) override { secPerBeat = spb; }
    // The frequency shifter's oscillator phase advances 2*pi*shiftHz/sr per sample
    // from 0: put it where a render from the start would have it at songSample.
    void seek(long long songSample) override {
        const double cycles = shiftHzOf(shift) * (double)songSample / sr;
        phase = 2.0 * kPi * (cycles - std::floor(cycles));
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

        int step = (int)std::ceil((double)sync * 23.0);
        if (step < 0) step = 0;
        if (step > 23) step = 23;
        const double delaySec = step <= 1 ? kFreeDelaySec : kSyncBeats[step] * secPerBeat;
        const long total = std::lround(delaySec * sr);
        if (total + 4 >= (long)delay.size())
            throw std::runtime_error("FreqShiftEcho: delay " + std::to_string(delaySec) +
                                     " s exceeds the " + std::to_string(kMaxDelaySec) + " s line");
        // At least one sample (the free step's 0.01 ms cannot be compensated).
        const int ds = total - kHilbertComp < 1 ? 1 : (int)(total - kHilbertComp);

        const double shiftHz = shiftHzOf(shift);
        const double hpHz = 20.0 + 2980.0 * lowCut;     // Valhalla display: 20 … 3000 Hz
        const double lpHz = 50.0 + 14950.0 * highCut;   // Valhalla display: 50 … 15000 Hz
        for (Tone* t : {&toneL, &toneR}) {
            t->hp.setCutoff(hpHz, sr); t->lp.setCutoff(lpHz, sr); t->hf.setLowpass(19155.0, 0.3, sr);
        }
        const double g = kFeedbackScale * feedback;
        const double wet = wetDryMix, dry = 1.0 - wetDryMix;
        const double dphi = 2.0 * kPi * shiftHz / sr;
        const int size = (int)delay.size();

        for (int i = 0; i < n; ++i) {
            int rpos = wpos - ds; if (rpos < 0) rpos += size;
            double I, Q; hb.process(delay[(size_t)rpos], I, Q);
            const double c = std::cos(phase), s = std::sin(phase);
            phase += dphi;
            if (phase > 2.0 * kPi) phase -= 2.0 * kPi; else if (phase < 0) phase += 2.0 * kPi;

            const double yL = kPassGain * toneL.process(I * c - Q * s);   // shifted up
            const double yR = kPassGain * toneR.process(I * c + Q * s);   // shifted down

            const double m = 0.5 * ((double)in[0][i] + (double)in[1][i]);
            delay[(size_t)wpos] = (float)(m + g * std::tanh(kSatK * yL) / kSatK);
            if (++wpos >= size) wpos = 0;

            const double inL = in[0][i], inR = in[1][i];   // read before writing (in may alias out)
            out[0][i] = (float)(dry * inL + wet * yL);
            out[1][i] = (float)(dry * inR + wet * yR);
        }
    }
};

} // namespace

std::unique_ptr<Plugin> makeFreqShiftEcho() { return std::make_unique<FreqShiftEchoImpl>(); }

} // namespace aw
} // namespace casperaki
