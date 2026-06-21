// Thunder (AirWindows, MIT — Chris Johnson/airwindows.com; vendored from Tracktion's
// 3rd_party/airwindows copy, which carries the old template header). Compiled
// portably via aw_shim.h (no JUCE/VST SDK). Namespaced unity TU; see docs/63 §6.
#include "aw_shim.h"

#include <cstdint>
#include <cstdlib>
#include <cmath>
#include <math.h>
#include <set>
#include <string>

namespace casperaki { namespace aw { namespace thunder {
#include "../../../vendor/airwindows/Thunder/Thunder.h"
#include "../../../vendor/airwindows/Thunder/ThunderProc.cpp"
#include "../../../vendor/airwindows/Thunder/Thunder.cpp"
}}} // namespace casperaki::aw::thunder

#include "AwAdapter.h"

namespace casperaki { namespace aw {
std::unique_ptr<Plugin> makeThunder() { return std::make_unique<AwAdapter<thunder::Thunder>>(thunder::kNumParameters); }
}}
