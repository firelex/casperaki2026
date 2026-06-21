// Unit test for the deterministic RNG (docs/60 Phase 1, step 1).
//
// Proves three things:
//   (1) Parity with juce::Random's arithmetic — the class reproduces an
//       independent inline transcription of juce_Random.cpp:74-85 across many
//       seeds/draws (guards signedness, mask width, shift).
//   (2) Determinism — same seed => identical stream, run to run; and the
//       song-hash seed is stable for the same bytes, distinct for different.
//   (3) The velocity-humanization delta `(nextInt(127)-65)/5` stays in range.
//
// Frozen golden values (pinned regression guard) are checked too so an
// accidental edit to the LCG constants fails loudly.

#include "../src/Random.h"

#include <cassert>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

using casperaki::Random;

namespace {

// Independent inline transcription of juce_Random.cpp:74-85 (the spec).
struct JuceSpec {
    int64_t seed;
    explicit JuceSpec(int64_t s) : seed(s) {}
    int nextInt() {
        seed = (int64_t)((((uint64_t)seed * 0x5deece66dULL) + 11ULL) & 0xffffffffffffULL);
        return (int)(seed >> 16);
    }
    int nextInt(int maxValue) {
        return (int)((((unsigned int)nextInt()) * (uint64_t)maxValue) >> 32);
    }
};

int failures = 0;
void check(bool cond, const char* msg) {
    if (!cond) { std::printf("FAIL: %s\n", msg); ++failures; }
}

} // namespace

int main() {
    // (1) Parity with the juce spec across seeds and both nextInt overloads.
    for (int64_t s : {(int64_t)1, (int64_t)42, (int64_t)123456789,
                      (int64_t)0xABCDEF, (int64_t)999999999999LL}) {
        Random r(s);
        JuceSpec spec(s);
        for (int i = 0; i < 5000; ++i)
            check(r.nextInt() == spec.nextInt(), "nextInt() != juce spec");
        Random r2(s);
        JuceSpec spec2(s);
        for (int i = 0; i < 5000; ++i)
            check(r2.nextInt(127) == spec2.nextInt(127), "nextInt(127) != juce spec");
    }

    // (2a) Determinism: same seed => identical stream.
    {
        Random a(20260616), b(20260616);
        for (int i = 0; i < 10000; ++i)
            check(a.nextInt() == b.nextInt(), "same seed diverged");
    }

    // (2b) Song-hash seed: stable for same bytes, distinct for different.
    {
        const std::string songA = "{\"genre\":\"brightPop\",\"tempo\":120}";
        const std::string songB = "{\"genre\":\"edm\",\"tempo\":128}";
        check(Random::seedFromString(songA) == Random::seedFromString(songA),
              "seedFromString not stable");
        check(Random::seedFromString(songA) != Random::seedFromString(songB),
              "seedFromString collided on distinct songs");
        check(Random::seedFromString("") != 0, "empty-string seed must avoid 0");
    }

    // (2c) Frozen golden — pins the LCG constants. seed=1, first 8 nextInt(127).
    {
        Random r(1);
        const int expect[8] = {0, 92, 110, 47, 100, 46, 39, 120};
        for (int i = 0; i < 8; ++i) {
            int got = r.nextInt(127);
            if (got != expect[i]) {
                std::printf("FAIL: golden[%d] expected %d got %d\n", i, expect[i], got);
                ++failures;
            }
        }
    }

    // (3) Velocity-humanization delta range: (nextInt(127)-65)/5 in [-13, 12].
    {
        Random r(7);
        for (int i = 0; i < 100000; ++i) {
            int delta = (r.nextInt(127) - 65) / 5;
            check(delta >= -13 && delta <= 12, "velocity delta out of range");
        }
    }

    if (failures == 0) std::printf("random_test: OK\n");
    else std::printf("random_test: %d FAILURE(S)\n", failures);
    return failures == 0 ? 0 : 1;
}
