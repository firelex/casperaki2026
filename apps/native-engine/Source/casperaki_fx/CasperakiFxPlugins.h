// CasperakiFxPlugins.h — in-tree Tracktion plugins wrapping the portable,
// JUCE-free Casperaki FX DSP that is SHARED with the WASM render engine
// (apps/web/wasm/engine/src/audio/airwindows/{FreqShiftEcho,SimpleSide}.cpp).
//
// These replace two external VSTs in the legacy rack chains so the native
// engine drops both the Wine/yabridge dependency (and its multi-hour teardown
// hang) and the GPLv3 dependency:
//   * CasperakiFreqShiftEchoPlugin  <- ValhallaFreqEcho (proprietary, Wine-bridged)
//   * CasperakiSimpleSidePlugin     <- SimpleSide (GPLv3)
//
// Because both run the SAME DSP as the WASM port, the native delay/pump now
// match the WASM render bit-for-bit in algorithm (exact JUCE<->WASM parity).
//
// Params are decoded from the legacy preset state by FXPluginRemap.h and handed
// in via the `casperakiFxParams` state attribute (space-separated [0,1] floats,
// in the order the matching aw::Plugin::setParam expects). Tempo + song time are
// threaded each block from the PluginRenderContext (SimpleSide is a tempo-synced
// pump; FreqShiftEcho is a tempo-synced echo).
#pragma once

#include <JuceHeader.h>
#include <memory>
#include <vector>

namespace casperaki { namespace aw { struct Plugin; } }

namespace tracktion { inline namespace engine
{

//==============================================================================
// Shared base: owns one portable aw::Plugin DSP, threads transport, processes
// the rack buffer in place. Subclasses pick the concrete DSP + identity.
class CasperakiFxPluginBase  : public Plugin
{
public:
    CasperakiFxPluginBase (PluginCreationInfo);
    ~CasperakiFxPluginBase() override;

    juce::String getSelectableDescription() override   { return getPluginType(); }
    bool isSynth() override                             { return false; }
    bool takesAudioInput() override                     { return true; }
    bool takesMidiInput() override                      { return false; }
    bool needsConstantBufferSize() override             { return false; }
    int getNumOutputChannelsGivenInputs (int n) override { return juce::jmin (n, 2); }

    void initialise (const PluginInitialisationInfo&) override;
    void deinitialise() override;
    void applyToBuffer (const PluginRenderContext&) override;
    void restorePluginStateFromValueTree (const juce::ValueTree&) override;

protected:
    // Subclass hook: build the concrete portable DSP (aw::makeFreqShiftEcho/makeSimpleSide).
    virtual std::unique_ptr<casperaki::aw::Plugin> createDsp() = 0;

    std::unique_ptr<casperaki::aw::Plugin> dsp;
    std::vector<float> params;
    juce::CriticalSection lock;

    void loadParamsFromState();   // parse `casperakiFxParams` -> params
    void applyParams();           // push params into the DSP (call under lock)
};

//==============================================================================
// ValhallaFreqEcho replacement — a frequency-shifting tempo-synced echo.
// 6 params: [wetDryMix, shift, feedback, sync, lowCut, highCut].
class CasperakiFreqShiftEchoPlugin  : public CasperakiFxPluginBase
{
public:
    CasperakiFreqShiftEchoPlugin (PluginCreationInfo i) : CasperakiFxPluginBase (i) {}

    static const char* xmlTypeName;
    static const char* getPluginName()                 { return NEEDS_TRANS ("Casperaki FreqShiftEcho"); }

    juce::String getName() const override              { return "Casperaki FreqShiftEcho"; }
    juce::String getPluginType() override              { return xmlTypeName; }
    juce::String getShortName (int) override           { return "FreqEcho"; }
    bool producesAudioWhenNoAudioInput() override      { return true; }   // echo tail must ring out

protected:
    std::unique_ptr<casperaki::aw::Plugin> createDsp() override;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (CasperakiFreqShiftEchoPlugin)
};

//==============================================================================
// SimpleSide replacement — a tempo-synced volume "pump" (faux sidechain).
// Params: [mix, rateValue, (x,y,rawExp) curve triples...].
class CasperakiSimpleSidePlugin  : public CasperakiFxPluginBase
{
public:
    CasperakiSimpleSidePlugin (PluginCreationInfo i) : CasperakiFxPluginBase (i) {}

    static const char* xmlTypeName;
    static const char* getPluginName()                 { return NEEDS_TRANS ("Casperaki SimpleSide"); }

    juce::String getName() const override              { return "Casperaki SimpleSide"; }
    juce::String getPluginType() override              { return xmlTypeName; }
    juce::String getShortName (int) override           { return "SimplSide"; }

protected:
    std::unique_ptr<casperaki::aw::Plugin> createDsp() override;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (CasperakiSimpleSidePlugin)
};

}} // namespace tracktion { inline namespace engine
