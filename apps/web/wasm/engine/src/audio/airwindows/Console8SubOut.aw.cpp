// Console8SubOut (AirWindows, MIT) — vendored + compiled portably via aw_shim.h (no JUCE/VST
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

namespace casperaki { namespace aw { namespace c8subout {
#include "../../../vendor/airwindows/Console8SubOut/Console8SubOut.h"
#include "../../../vendor/airwindows/Console8SubOut/Console8SubOutProc.cpp"
#include "../../../vendor/airwindows/Console8SubOut/Console8SubOut.cpp"
}}} // namespace casperaki::aw::c8subout

#include "AwAdapter.h"

namespace casperaki { namespace aw {
std::unique_ptr<Plugin> makeConsole8SubOut() { return std::make_unique<AwAdapter<c8subout::Console8SubOut>>(c8subout::kNumParameters); }
}}
