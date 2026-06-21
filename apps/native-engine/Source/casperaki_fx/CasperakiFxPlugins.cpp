// CasperakiFxPlugins.cpp — see CasperakiFxPlugins.h. Thin Tracktion-plugin
// wrappers over the shared portable DSP (the same FreqShiftEcho/SimpleSide
// source the WASM render engine compiles). No JUCE leaks into the DSP: it is
// driven only through the aw::Plugin interface.
#include "CasperakiFxPlugins.h"

// The portable DSP interface + factories. AwPlugins.h lives in the shared WASM
// engine tree (apps/web/wasm/engine/src/audio/airwindows); the spike CMake adds
// that dir to the include path and compiles FreqShiftEcho.cpp + SimpleSide.cpp.
#include "AwPlugins.h"

namespace tracktion { inline namespace engine
{

//==============================================================================
CasperakiFxPluginBase::CasperakiFxPluginBase (PluginCreationInfo info)  : Plugin (info)
{
    loadParamsFromState();
}

CasperakiFxPluginBase::~CasperakiFxPluginBase()
{
    notifyListenersOfDeletion();
}

void CasperakiFxPluginBase::loadParamsFromState()
{
    params.clear();

    const auto packed = state.getProperty (juce::Identifier ("casperakiFxParams")).toString();
    if (packed.isEmpty())
        return;

    for (auto& tok : juce::StringArray::fromTokens (packed, " ", {}))
        if (tok.isNotEmpty())
            params.push_back ((float) tok.getDoubleValue());
}

void CasperakiFxPluginBase::applyParams()
{
    if (dsp == nullptr)
        return;

    for (int i = 0; i < (int) params.size(); ++i)
        dsp->setParam (i, params[(size_t) i]);
}

void CasperakiFxPluginBase::initialise (const PluginInitialisationInfo&)
{
    const juce::ScopedLock sl (lock);

    dsp = createDsp();

    if (dsp != nullptr)
    {
        dsp->setSampleRate (sampleRate);
        applyParams();
    }
}

void CasperakiFxPluginBase::deinitialise()
{
    const juce::ScopedLock sl (lock);
    dsp.reset();
}

void CasperakiFxPluginBase::restorePluginStateFromValueTree (const juce::ValueTree& v)
{
    copyValueTree (state, v, getUndoManager());
    loadParamsFromState();

    const juce::ScopedLock sl (lock);
    applyParams();
}

void CasperakiFxPluginBase::applyToBuffer (const PluginRenderContext& fc)
{
    if (fc.destBuffer == nullptr)
        return;

    SCOPED_REALTIME_CHECK

    const juce::ScopedLock sl (lock);

    if (dsp == nullptr)
        return;

    // Thread transport so the tempo-synced DSP locks to the song timeline.
    // editTime is the absolute edit time; SimpleSide phases its pump off it and
    // FreqShiftEcho sizes its delay from secPerBeat.
    const auto blockStart = fc.editTime.getStart();
    const double timeSec    = blockStart.inSeconds();
    const double bpm        = edit.tempoSequence.getBpmAt (blockStart);
    const double secPerBeat = bpm > 0.0 ? 60.0 / bpm : 0.5;
    dsp->setTransport (secPerBeat, timeSec);

    const int numChans = juce::jmin (2, fc.destBuffer->getNumChannels());
    if (numChans <= 0)
        return;

    float* ch0 = fc.destBuffer->getWritePointer (0, fc.bufferStartSample);

    if (numChans >= 2)
    {
        float* ch1 = fc.destBuffer->getWritePointer (1, fc.bufferStartSample);
        float* chans[2] = { ch0, ch1 };
        dsp->process (chans, chans, fc.bufferNumSamples);
    }
    else
    {
        // Mono path (racks here are stereo, so this is a safety fallback): give
        // the stereo DSP a duplicated right channel and keep the processed left.
        AudioScratchBuffer scratch (1, fc.bufferNumSamples);
        scratch.buffer.copyFrom (0, 0, ch0, fc.bufferNumSamples);
        float* chans[2] = { ch0, scratch.buffer.getWritePointer (0) };
        dsp->process (chans, chans, fc.bufferNumSamples);
    }
}

//==============================================================================
// xmlTypeName MUST match the rewrite targets in FXPluginRemap.h.
const char* CasperakiFreqShiftEchoPlugin::xmlTypeName = "casperaki_freqshiftecho";
const char* CasperakiSimpleSidePlugin::xmlTypeName    = "casperaki_simpleside";

std::unique_ptr<casperaki::aw::Plugin> CasperakiFreqShiftEchoPlugin::createDsp()
{
    return casperaki::aw::makeFreqShiftEcho();
}

std::unique_ptr<casperaki::aw::Plugin> CasperakiSimpleSidePlugin::createDsp()
{
    return casperaki::aw::makeSimpleSide();
}

}} // namespace tracktion { inline namespace engine
