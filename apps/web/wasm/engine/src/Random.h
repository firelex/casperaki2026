// Deterministic RNG for the bespoke WASM render engine (docs/60 Phase 1, step 1).
//
// docs/61 §2 root-caused the native render's non-determinism to JUCE's
// `juce::Random` being default-constructed (SequencerUtils.h:73), which seeds
// from the wall clock (Time::getHighResolutionTicks); it drives velocity
// humanization (SequencerUtils.h:653) so the velocity grid differs every run.
//
// The WASM engine OWNS its RNG, so we make it deterministic: a faithful
// transcription of `juce::Random`'s 48-bit LCG (the exact algorithm from
// juce_Random.cpp:74-85) seeded from a fixed value or the song hash. Same
// `song.json` -> same humanization, every run. This is the precondition for the
// golden oracle being a near-exact null instead of a per-band tolerance.
//
// The arithmetic below is byte-for-byte the JUCE implementation so the velocity
// stream is identical to JUCE's *for the same seed and draw order* — only the
// seed source changes (deterministic instead of clock-based).
#pragma once

#include <cstdint>
#include <string>

namespace casperaki {

class Random {
public:
    Random() : seed_(1) {}
    explicit Random(int64_t seedValue) : seed_(seedValue) {}

    void setSeed(int64_t newSeed) { seed_ = newSeed; }
    int64_t getSeed() const { return seed_; }

    // juce_Random.cpp:74-79 — `seed = (seed*0x5deece66d + 11) & 0xffffffffffff`.
    int nextInt() {
        seed_ = (int64_t)((((uint64_t)seed_ * 0x5deece66dULL) + 11ULL)
                          & 0xffffffffffffULL);
        return (int)(seed_ >> 16);
    }

    // juce_Random.cpp:81-85 — note the `(unsigned int)` cast before the widen,
    // so the high bits of a "negative" nextInt() participate. Caller must pass
    // maxValue > 0 (JUCE asserts it); we clamp to 0 for safety.
    int nextInt(int maxValue) {
        if (maxValue <= 0) return 0;
        return (int)((((unsigned int)nextInt()) * (uint64_t)maxValue) >> 32);
    }

    // FNV-1a 64-bit over the canonical song bytes. Gives every distinct
    // `song.json` its own reproducible humanization seed while staying stable
    // run-to-run. Use a fixed seed instead when bit-matching a native golden
    // that was itself rendered with a known seed.
    static int64_t seedFromString(const std::string& s) {
        uint64_t h = 1469598103934665603ULL; // FNV offset basis
        for (unsigned char c : s) {
            h ^= (uint64_t)c;
            h *= 1099511628211ULL; // FNV prime
        }
        // Mask to the LCG's 48-bit state space; avoid the all-zero degenerate
        // seed (which the LCG would otherwise advance slowly out of).
        int64_t seed = (int64_t)(h & 0xffffffffffffULL);
        return seed == 0 ? 1 : seed;
    }

private:
    int64_t seed_;
};

} // namespace casperaki
