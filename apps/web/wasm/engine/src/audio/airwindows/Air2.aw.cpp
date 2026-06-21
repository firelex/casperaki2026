// Air2 (AirWindows, MIT) — vendored + compiled portably via aw_shim.h (no JUCE/VST
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

namespace casperaki { namespace aw { namespace air2 {
#include "../../../vendor/airwindows/Air2/Air2.h"
#include "../../../vendor/airwindows/Air2/Air2Proc.cpp"
#include "../../../vendor/airwindows/Air2/Air2.cpp"
}}} // namespace casperaki::aw::air2

#include "AwAdapter.h"

namespace casperaki { namespace aw {
std::unique_ptr<Plugin> makeAir2() { return std::make_unique<AwAdapter<air2::Air2>>(air2::kNumParameters); }
}}
