// Thin C++ wrapper around the matchering port (../../../../matchering).
//
// Matchering.h does `using namespace juce;` AND `using namespace Matchering;`
// at file scope; including it directly into harness.cpp would leak both
// namespaces into the harness TU. This header keeps the surface tiny so
// the harness only sees a clean signature.
//
// Backed by masterSongAtemlos() — reads the source WAV, mastering against
// the embedded referenceAtemlos.wav, writes the result to dest. Both paths
// are absolute. sampleRate is locked to 44100 by the matchering port.

#pragma once

#include <JuceHeader.h>

namespace casperaki::matchering
{

// Run the legacy matchering chain on `src`, write the result to `dst`.
// `shouldLimit` controls the final Casperaki_NC17 brickwall pass; passing
// true matches the legacy InstrumentalGenerator behaviour.
void masterAgainstAtemlos (const juce::File& src,
                           const juce::File& dst,
                           bool shouldLimit = true);

} // namespace casperaki::matchering
