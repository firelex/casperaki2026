// StereoChorus (AirWindows, MIT) — vendored + compiled portably via aw_shim.h (no JUCE/VST
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

namespace casperaki { namespace aw { namespace stereochorus {
#include "../../../vendor/airwindows/StereoChorus/StereoChorus.h"
#include "../../../vendor/airwindows/StereoChorus/StereoChorusProc.cpp"
#include "../../../vendor/airwindows/StereoChorus/StereoChorus.cpp"
}}} // namespace casperaki::aw::stereochorus

#include "AwAdapter.h"

namespace casperaki { namespace aw {
// The chorus LFO phase is position-derived state, so it follows a seek.
struct StereoChorusAdapter : AwAdapter<stereochorus::StereoChorus> {
    StereoChorusAdapter() : AwAdapter(stereochorus::kNumParameters) {}
    void seek(long long songSample) override { p.casperakiSeek(songSample); }
};
std::unique_ptr<Plugin> makeStereoChorus() { return std::make_unique<StereoChorusAdapter>(); }
}}
