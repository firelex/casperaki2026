// EQ (AirWindows, MIT — Chris Johnson/airwindows.com; vendored from Tracktion's
// 3rd_party/airwindows copy, which carries the old template header). Compiled
// portably via aw_shim.h (no JUCE/VST SDK). Namespaced unity TU; see docs/63 §6.
#include "aw_shim.h"

#include <cstdint>
#include <cstdlib>
#include <cmath>
#include <math.h>
#include <set>
#include <string>

namespace casperaki { namespace aw { namespace aweq {
#include "../../../vendor/airwindows/EQ/EQ.h"
#include "../../../vendor/airwindows/EQ/EQProc.cpp"
#include "../../../vendor/airwindows/EQ/EQ.cpp"
}}} // namespace casperaki::aw::aweq

#include "AwAdapter.h"

namespace casperaki { namespace aw {
std::unique_ptr<Plugin> makeEQ() { return std::make_unique<AwAdapter<aweq::EQ>>(aweq::kNumParameters); }
}}
