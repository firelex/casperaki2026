// ADClip7 (AirWindows, MIT — Chris Johnson/airwindows.com; vendored from Tracktion's
// 3rd_party/airwindows copy, which carries the old template header). Compiled
// portably via aw_shim.h (no JUCE/VST SDK). Namespaced unity TU; see docs/63 §6.
#include "aw_shim.h"

#include <cstdint>
#include <cstdlib>
#include <cmath>
#include <math.h>
#include <set>
#include <string>

namespace casperaki { namespace aw { namespace adclip7 {
#include "../../../vendor/airwindows/ADClip7/ADClip7.h"
#include "../../../vendor/airwindows/ADClip7/ADClip7Proc.cpp"
#include "../../../vendor/airwindows/ADClip7/ADClip7.cpp"
}}} // namespace casperaki::aw::adclip7

#include "AwAdapter.h"

namespace casperaki { namespace aw {
std::unique_ptr<Plugin> makeADClip7() { return std::make_unique<AwAdapter<adclip7::ADClip7>>(adclip7::kNumParameters); }
}}
