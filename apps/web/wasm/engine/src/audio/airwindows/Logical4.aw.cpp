// Logical4 (AirWindows, MIT — Chris Johnson/airwindows.com; vendored from Tracktion's
// 3rd_party/airwindows copy, which carries the old template header). Compiled
// portably via aw_shim.h (no JUCE/VST SDK). Namespaced unity TU; see docs/63 §6.
#include "aw_shim.h"

#include <cstdint>
#include <cstdlib>
#include <cmath>
#include <math.h>
#include <set>
#include <string>

namespace casperaki { namespace aw { namespace logical4 {
#include "../../../vendor/airwindows/Logical4/Logical4.h"
#include "../../../vendor/airwindows/Logical4/Logical4Proc.cpp"
#include "../../../vendor/airwindows/Logical4/Logical4.cpp"
}}} // namespace casperaki::aw::logical4

#include "AwAdapter.h"

namespace casperaki { namespace aw {
std::unique_ptr<Plugin> makeLogical4() { return std::make_unique<AwAdapter<logical4::Logical4>>(logical4::kNumParameters); }
}}
