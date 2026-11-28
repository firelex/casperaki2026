// Drum hit velocity by position in the bar, as the legacy app played it (casperaki2-engine-js
// api/v1.0/services/tracks/drumTrack.js:183-210; owner 2026-11-28 "change the engine to match legacy behavior").
// On the 32-steps-a-bar grid: the bar's first step, the middle of the bar, the other beats, and every step between
// beats; hip-hop (Urban) 100/90/80/70, every other style 100/87/75/50. The strongest hit keeps the engine's 127.
#include "../src/Drums.h"

#include <cstdio>

static int failures = 0;
static void expectEq(int got, int want, const char* what) {
    if (got != want) { std::printf("FAIL %s: got %d, want %d\n", what, got, want); ++failures; }
}
static int scaled(int legacy) { return (int)std::lround(127.0 * legacy / 100.0); }

int main() {
    using casperaki::legacyDrumVelocity;
    expectEq(legacyDrumVelocity(0, false), 127, "bar start");
    expectEq(legacyDrumVelocity(32, false), 127, "next bar start");
    expectEq(legacyDrumVelocity(16, false), scaled(87), "middle of the bar");
    expectEq(legacyDrumVelocity(8, false), scaled(75), "beat 2");
    expectEq(legacyDrumVelocity(24, false), scaled(75), "beat 4");
    expectEq(legacyDrumVelocity(4, false), scaled(50), "an 8th off the beat");
    expectEq(legacyDrumVelocity(2, false), scaled(50), "a 16th off the beat");
    expectEq(legacyDrumVelocity(16, true), scaled(90), "hip-hop middle of the bar");
    expectEq(legacyDrumVelocity(8, true), scaled(80), "hip-hop beat 2");
    expectEq(legacyDrumVelocity(6, true), scaled(70), "hip-hop between beats");
    if (failures == 0) std::printf("drum_velocity_test: all passed\n");
    return failures == 0 ? 0 : 1;
}
