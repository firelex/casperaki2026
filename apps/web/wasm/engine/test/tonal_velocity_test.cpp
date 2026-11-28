// Tonal note and Virtual Guitarist strum velocity by position in the bar, as the legacy app played it
// (casperaki2-engine-js api/v1.0/services/classes/renderer/HelperClass.js:540-564; owner 2026-11-28 "Switch, like
// drums"): the bar's first beat 0.8, the middle of the bar 0.7, the other beats 0.6, between beats 0.5, each plus a
// random +-0.1. Scaled by 0.9/0.8 so the bar's first beat keeps the engine's former 0.9.
#include "../src/Tonal.h"

#include <cmath>
#include <cstdio>

static int failures = 0;
static void expect(bool ok, const char* what, double got) {
    if (!ok) { std::printf("FAIL %s (got %.3f)\n", what, got); ++failures; }
}

int main() {
    using namespace casperaki;
    Random rng; rng.setSeed(Random::seedFromString("tonal velocity test"));
    const double scale = 0.9 / 0.8;
    struct Case { double beat; double legacy; const char* what; } cases[] = {
        {0.0, 0.8, "bar start"}, {4.0, 0.8, "next bar start"}, {2.0, 0.7, "middle of the bar"},
        {1.0, 0.6, "beat 2"}, {3.0, 0.6, "beat 4"}, {0.5, 0.5, "an 8th off the beat"}, {2.75, 0.5, "a 16th off the beat"},
    };
    for (const auto& c : cases) {
        const double centre = c.legacy * scale * 127.0, spread = 0.1 * scale * 127.0;
        double sum = 0, lo = 1e9, hi = -1e9; const int n = 4000;
        for (int i = 0; i < n; ++i) {
            const int v = legacyTonalVelocity(c.beat, rng);
            sum += v; lo = std::min(lo, (double)v); hi = std::max(hi, (double)v);
        }
        expect(std::fabs(sum / n - centre) < 1.0, c.what, sum / n);
        expect(lo >= centre - spread - 1 && hi <= centre + spread + 1, c.what, hi - lo);
        expect(hi - lo > spread, "the random spread is used", hi - lo);
    }
    // Deterministic: the same seed gives the same velocities.
    Random a, b; a.setSeed(7); b.setSeed(7);
    for (int i = 0; i < 50; ++i) expect(legacyTonalVelocity(i * 0.25, a) == legacyTonalVelocity(i * 0.25, b), "same seed", i);
    if (failures == 0) std::printf("tonal_velocity_test: all passed\n");
    return failures == 0 ? 0 : 1;
}
