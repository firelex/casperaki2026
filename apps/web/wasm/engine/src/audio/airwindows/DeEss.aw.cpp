// DeEss (AirWindows, MIT) — vendored + compiled portably via aw_shim.h (no JUCE/VST
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

namespace casperaki { namespace aw { namespace deess {
#include "../../../vendor/airwindows/DeEss/DeEss.h"
#include "../../../vendor/airwindows/DeEss/DeEssProc.cpp"
#include "../../../vendor/airwindows/DeEss/DeEss.cpp"
}}} // namespace casperaki::aw::deess

#include "AwAdapter.h"

namespace casperaki { namespace aw {
std::unique_ptr<Plugin> makeDeEss() { return std::make_unique<AwAdapter<deess::DeEss>>(deess::kNumParameters); }
}}
