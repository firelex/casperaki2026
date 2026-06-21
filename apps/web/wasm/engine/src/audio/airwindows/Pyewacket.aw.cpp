// Pyewacket (AirWindows, MIT — Chris Johnson/airwindows.com; vendored from Tracktion's
// 3rd_party/airwindows copy, which carries the old template header). Compiled
// portably via aw_shim.h (no JUCE/VST SDK). Namespaced unity TU; see docs/63 §6.
#include "aw_shim.h"

#include <cstdint>
#include <cstdlib>
#include <cmath>
#include <math.h>
#include <set>
#include <string>

namespace casperaki { namespace aw { namespace pyewacket {
#include "../../../vendor/airwindows/Pyewacket/Pyewacket.h"
#include "../../../vendor/airwindows/Pyewacket/PyewacketProc.cpp"
#include "../../../vendor/airwindows/Pyewacket/Pyewacket.cpp"
}}} // namespace casperaki::aw::pyewacket

#include "AwAdapter.h"

namespace casperaki { namespace aw {
std::unique_ptr<Plugin> makePyewacket() { return std::make_unique<AwAdapter<pyewacket::Pyewacket>>(pyewacket::kNumParameters); }
}}
