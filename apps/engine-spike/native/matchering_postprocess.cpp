#include "matchering_postprocess.h"

// Matchering.h pulls in BinaryData::referenceAtemlos_wav and
// BinaryData::atemlos_json — both wired up in CMakeLists.txt via
// juce_add_binary_data(casperaki_spike_assets ...).
//
// `using namespace juce;` and `using namespace Matchering;` live inside
// matchering's headers — keep them contained to this TU only.
#include "Matchering.h"

namespace casperaki::matchering
{

bool masterAgainstAtemlos (const juce::File& src,
                           const juce::File& dst,
                           bool shouldLimit)
{
    if (! src.existsAsFile())
    {
        std::cerr << "[matchering] source missing: "
                  << src.getFullPathName() << std::endl;
        return false;
    }

    // masterSongAtemlos() is `inline` (Matchering.h:1881) and reads the
    // baked-in atemlos reference WAV via BinaryData. shouldMaster=true
    // mirrors InstrumentalGenerator::saveAndExportSong's call.
    ::masterSongAtemlos (src.getFullPathName(),
                         dst.getFullPathName(),
                         /*shouldMaster*/ true,
                         shouldLimit,
                         /*sampleRate*/ 44100.0,
                         /*isVibe*/ false);
    return true;
}

} // namespace casperaki::matchering
