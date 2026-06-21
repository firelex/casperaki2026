// Console8BussOut (AirWindows, MIT) — vendored + compiled portably via aw_shim.h (no JUCE/VST
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

namespace casperaki { namespace aw { namespace c8bussout {
#include "../../../vendor/airwindows/Console8BussOut/Console8BussOut.h"
#include "../../../vendor/airwindows/Console8BussOut/Console8BussOutProc.cpp"
#include "../../../vendor/airwindows/Console8BussOut/Console8BussOut.cpp"
}}} // namespace casperaki::aw::c8bussout

#include "AwAdapter.h"

namespace casperaki { namespace aw {
std::unique_ptr<Plugin> makeConsole8BussOut() { return std::make_unique<AwAdapter<c8bussout::Console8BussOut>>(c8bussout::kNumParameters); }
}}
