// NCSeventeen (AirWindows, MIT — Chris Johnson/airwindows.com; vendored from Tracktion's
// 3rd_party/airwindows copy, which carries the old template header). Compiled
// portably via aw_shim.h (no JUCE/VST SDK). Namespaced unity TU; see docs/63 §6.
#include "aw_shim.h"

#include <cstdint>
#include <cstdlib>
#include <cmath>
#include <math.h>
#include <set>
#include <string>

namespace casperaki { namespace aw { namespace ncseventeen {
#include "../../../vendor/airwindows/NC-17/NCSeventeen.h"
#include "../../../vendor/airwindows/NC-17/NCSeventeenProc.cpp"
#include "../../../vendor/airwindows/NC-17/NCSeventeen.cpp"
}}} // namespace casperaki::aw::ncseventeen

#include "AwAdapter.h"

namespace casperaki { namespace aw {
std::unique_ptr<Plugin> makeNC17() { return std::make_unique<AwAdapter<ncseventeen::NCSeventeen>>(ncseventeen::kNumParameters); }
}}
