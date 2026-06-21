// SimpleSide — a CLEAN REIMPLEMENTATION of the tempo-synced volume "pump" (a
// faux-sidechain), NOT a copy of the GPLv3 source (github.com/KottV/SimpleSide).
// docs/60/61 sanctioned reimplementing its behaviour. The algorithm (understood
// from the plugin, re-expressed here independently):
//
//   rate cycle length  = 2^rateValue  beats
//   phase in cycle      = fmod(songTime/secPerBeat, rate) / rate   in [0,1)
//   envelope            = primaryCurve.at(phase)                    a piecewise
//       power-curve over control points (x,y,rawExp); per segment pwr=1.1^|rawExp|,
//       y = pow(u,pwr)·Δy + y0  (or the mirrored form by rawExp sign / rising)
//   gain scale          = (exp(envelope) - 1) / (e - 1)            log-shaped
//   out                 = in·scale·mix + in·(1 - mix)              dry/wet pump
//
// Params (from the SimpleSide state, decoded by extract-rack-data.mjs into a flat
// array): [0]=mix, [1]=rateValue, then (x,y,rawExp) triples for the curve points.
#include "AwPlugins.h"

#include <cmath>
#include <vector>

namespace casperaki {
namespace aw {
namespace {

struct SimpleSideImpl : Plugin {
    struct Pt { float x = 0, y = 0, rawExp = 0; };

    double mix = 0.5, rateValue = 0.0;
    double secPerBeat = 0.5, timeSec = 0.0, sampleRate = 44100.0;
    std::vector<Pt> pts;

    int  numParams() const override { return 2 + 3 * 16; }   // mix, rate, up to 16 points
    void setSampleRate(double sr) override { sampleRate = sr; }
    void setTransport(double spb, double t) override { secPerBeat = spb; timeSec = t; }

    void setParam(int i, float v) override {
        if (i == 0) { mix = v; return; }
        if (i == 1) { rateValue = v; return; }
        const int j = i - 2, pi = j / 3, comp = j % 3;
        if ((int)pts.size() <= pi) pts.resize((size_t)pi + 1);
        if (comp == 0) pts[(size_t)pi].x = v;
        else if (comp == 1) pts[(size_t)pi].y = v;
        else pts[(size_t)pi].rawExp = v;
    }

    // SSMultiCurve::at + SSCurve::getY, reimplemented.
    double curveAt(double t) const {
        if (pts.size() < 2) return 1.0;
        for (size_t i = 0; i + 1 < pts.size(); ++i)
            if (t >= pts[i].x && t <= pts[i + 1].x) return segY(pts[i], pts[i + 1], t);
        return pts.back().y;   // beyond the last handle (native returns -1; negligible edge)
    }

    static double segY(const Pt& a, const Pt& b, double x) {
        const double rawExp = a.rawExp;
        const double pwr = std::pow(1.1, std::fabs(rawExp));   // SSCurve::setPow
        const bool rising = a.y < b.y;
        const double span = (b.x - a.x);
        const double u = span > 1e-12 ? (x - a.x) / span : 0.0;
        if ((rawExp >= 0 && rising) || (rawExp < 0 && !rising))
            return std::pow(u, pwr) * (b.y - a.y) + a.y;
        return -1.0 * (std::pow(1.0 - u, pwr) - 1.0) * (b.y - a.y) + a.y;
    }

    void process(float* const* in, float* const* out, int n) override {
        const double r = std::pow(2.0, rateValue);
        const double inc = 1.0 / sampleRate;
        const double e1 = 1.7182818284590452;   // e - 1
        for (int ch = 0; ch < 2; ++ch) {
            double t = timeSec;                  // each channel starts at the same song time
            for (int s = 0; s < n; ++s) {
                const double numBeats = t / secPerBeat;
                double phase = std::fmod(numBeats, r) / r;
                phase -= std::floor(phase);      // -> [0,1)
                const double lfo = curveAt(phase);
                const double scale = (std::exp(lfo) - 1.0) / e1;
                out[ch][s] = (float)(in[ch][s] * scale * mix + in[ch][s] * (1.0 - mix));
                t += inc;
            }
        }
    }
};

} // namespace

std::unique_ptr<Plugin> makeSimpleSide() { return std::make_unique<SimpleSideImpl>(); }

} // namespace aw
} // namespace casperaki
