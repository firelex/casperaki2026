// Console8BussIn (AirWindows, MIT) — vendored + compiled portably via aw_shim.h (no JUCE/VST
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

namespace casperaki { namespace aw { namespace c8bussin {
#include "../../../vendor/airwindows/Console8BussIn/Console8BussIn.h"
#include "../../../vendor/airwindows/Console8BussIn/Console8BussInProc.cpp"
#include "../../../vendor/airwindows/Console8BussIn/Console8BussIn.cpp"
}}} // namespace casperaki::aw::c8bussin

#include "AwAdapter.h"

namespace casperaki { namespace aw {
std::unique_ptr<Plugin> makeConsole8BussIn() { return std::make_unique<AwAdapter<c8bussin::Console8BussIn>>(c8bussin::kNumParameters); }
}}
