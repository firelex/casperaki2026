// TapeDelay (AirWindows, MIT — substitute for ValhallaFreqEcho on the delay
// return; closest available echo: feedback + Depth flutter = the moving/detuned
// character nearest the freq-shift echo). Vendored from the Tracktion bundle,
// compiled portably via aw_shim.h. Namespaced unity TU; see docs/63 §6.
#include "aw_shim.h"

#include <cstdint>
#include <cstdlib>
#include <cmath>
#include <math.h>
#include <set>
#include <string>

namespace casperaki { namespace aw { namespace tapedelay {
#include "../../../vendor/airwindows/TapeDelay/TapeDelay.h"
#include "../../../vendor/airwindows/TapeDelay/TapeDelayProc.cpp"
#include "../../../vendor/airwindows/TapeDelay/TapeDelay.cpp"
}}} // namespace casperaki::aw::tapedelay

#include "AwAdapter.h"

namespace casperaki { namespace aw {
std::unique_ptr<Plugin> makeTapeDelay() { return std::make_unique<AwAdapter<tapedelay::TapeDelay>>(tapedelay::kNumParameters); }
}}
