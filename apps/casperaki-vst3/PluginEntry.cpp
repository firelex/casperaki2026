// Per-target VST3 entry point. Each plugin target compiles this TU with its own
// CASP_FACTORY define (the casperaki::aw make*() function it wraps) and its own
// JucePlugin_Name (from juce_add_plugin PRODUCT_NAME). The DSP, params and audio
// are all handled by the shared AwProcessor.
#ifdef CASP_SIMPLESIDE
 // SimpleSide needs the bespoke processor (variable active control-point count).
 #include "SimpleSideProcessor.h"
 juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
 {
     return new SimpleSideProcessor (JucePlugin_Name);
 }
#else
 #include "AwProcessor.h"
 #ifndef CASP_FACTORY
  #error "CASP_FACTORY must be defined per target (e.g. -DCASP_FACTORY=makeFreqShiftEcho)"
 #endif
 juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
 {
     return new AwProcessor (&casperaki::aw::CASP_FACTORY, JucePlugin_Name);
 }
#endif
