// Huge (AirWindows, MIT) — vendored + compiled portably via aw_shim.h (no JUCE/VST
// SDK). Namespaced unity TU; see Console8SubIn.aw.cpp / docs/63 §6 for the pattern.
#include "aw_shim.h"

// System headers the vendored plugin needs, pulled in at GLOBAL scope first so the
// plugin's own includes (inside the namespace) are guarded no-ops.
#include <cstdint>
#include <cstdlib>
#include <cmath>
#include <math.h>
#include <set>
#include <string>

namespace casperaki { namespace aw { namespace huge {
#include "../../../vendor/airwindows/Huge/Huge.h"
#include "../../../vendor/airwindows/Huge/HugeProc.cpp"
#include "../../../vendor/airwindows/Huge/Huge.cpp"
}}} // namespace casperaki::aw::huge

#include "AwAdapter.h"

namespace casperaki { namespace aw {
std::unique_ptr<Plugin> makeHuge() { return std::make_unique<AwAdapter<huge::Huge>>(huge::kNumParameters); }
}}
