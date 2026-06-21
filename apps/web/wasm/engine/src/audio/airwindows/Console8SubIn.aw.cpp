// Console8SubIn (AirWindows, MIT) — the Console8 "sub bus" input stage (console
// encode + ultrasonic biquad + slew soften). Vendored + compiled portably via
// aw_shim.h (no JUCE/VST SDK). Namespaced unity TU; see docs/63 §6 for the pattern.
#include "aw_shim.h"

// System headers the vendored plugin needs, pulled in at GLOBAL scope first so the
// plugin's own includes (inside the namespace) are guarded no-ops.
#include <cstdint>
#include <cstdlib>
#include <cmath>
#include <math.h>
#include <set>
#include <string>

namespace casperaki { namespace aw { namespace c8subin {
#include "../../../vendor/airwindows/Console8SubIn/Console8SubIn.h"
#include "../../../vendor/airwindows/Console8SubIn/Console8SubInProc.cpp"
#include "../../../vendor/airwindows/Console8SubIn/Console8SubIn.cpp"
}}} // namespace casperaki::aw::c8subin

#include "AwAdapter.h"

namespace casperaki { namespace aw {
std::unique_ptr<Plugin> makeConsole8SubIn() { return std::make_unique<AwAdapter<c8subin::Console8SubIn>>(c8subin::kNumParameters); }
}}
