// Portable rand() for the vendored AirWindows plugins. They call the C library's
// rand() to seed their per-plugin noise generators (fpdL/fpdR, in the
// constructor) and for per-sample dither. glibc (native build) and musl
// (emscripten/wasm build) implement rand() differently, so the same song came out
// with different noise/texture in the browser than on the server (TexturizeMS's
// texture walk is driven by that seed and is clearly audible in the difference).
// aw_shim.h maps rand() to portableRand(), a bit-exact copy of glibc's rand()
// (random_r TYPE_3, seed 1), so the native render is unchanged and the wasm build
// now draws the very same numbers. MixGraph::build reseeds it to 1 so every
// build starts from the state a fresh process has (the worklet may build several
// songs in one wasm instance).
#pragma once

#include <cstdint>

namespace casperaki {
namespace aw {

struct PortableRandState {
    int32_t st[31];
    int f = 3, r = 0;
};

inline PortableRandState& portableRandState() {
    static PortableRandState s;
    return s;
}

inline int portableRand() {
    PortableRandState& s = portableRandState();
    const uint32_t v = (uint32_t)s.st[s.f] + (uint32_t)s.st[s.r];
    s.st[s.f] = (int32_t)v;
    const int res = (int)(v >> 1);
    if (++s.f >= 31) { s.f = 0; ++s.r; }
    else if (++s.r >= 31) s.r = 0;
    return res;
}

// glibc srandom_r: Park-Miller fill, then discard 310 outputs.
inline void seedPortableRand(uint32_t seed) {
    PortableRandState& s = portableRandState();
    if (seed == 0) seed = 1;
    s.st[0] = (int32_t)seed;
    int64_t w = seed;
    for (int i = 1; i < 31; ++i) {
        const int64_t hi = w / 127773, lo = w % 127773;
        w = 16807 * lo - 2836 * hi;
        if (w < 0) w += 2147483647;
        s.st[i] = (int32_t)w;
    }
    s.f = 3;
    s.r = 0;
    for (int i = 0; i < 310; ++i) portableRand();
}

// The state a fresh process starts in (glibc's rand() before any srand()).
struct PortableRandInit {
    PortableRandInit() { seedPortableRand(1); }
};
inline PortableRandInit portableRandInit_;

} // namespace aw
} // namespace casperaki
