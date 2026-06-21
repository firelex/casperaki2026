// AwProcessor — a generic juce::AudioProcessor that hosts ONE Casperaki shared-DSP
// effect (casperaki::aw::Plugin) so it can be built as a VST3 a producer installs
// and opens in stock Waveform/Tracktion. Every Casperaki-custom effect (the 2
// bespoke FX + the AirWindows "extras") exposes the same uniform interface
// (numParams / setParam[0,1] / setTransport / process), so one processor class
// serves them all — the per-effect target only differs by its factory + identity.
//
// The DSP is the SAME source the render engine uses (apps/web/wasm/engine/.../
// airwindows), so a VST3 instance with the same param values renders the same
// audio as the internal plugin it replaces — which is what makes the exported
// edit faithful.
//
// FAITHFUL for: FreqShiftEcho (6 fixed [0,1] params) + every AirWindows extra
// (fixed [0,1] param counts). NOT yet faithful for SimpleSide (docs/65 TODO):
// its setParam() GROWS a control-point list (pts.resize(pi+1)), so the active
// point count = the number of params set, and rawExp values exceed [0,1]. The
// generic "expose numParams() [0,1] params and push them all" model would inject
// phantom zero-points and break the pump. SimpleSide needs a bespoke layout
// (an explicit numPoints param + wide ranges) before its VST3 is export-faithful.
#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include "AwPlugins.h"   // casperaki::aw::Plugin + the make*() factories

class AwProcessor : public juce::AudioProcessor
{
public:
    using Factory = std::unique_ptr<casperaki::aw::Plugin> (*)();

    AwProcessor (Factory factory, const juce::String& displayName)
        : juce::AudioProcessor (BusesProperties()
              .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
              .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
          name (displayName),
          dsp (factory())
    {
        const int n = dsp ? dsp->numParams() : 0;
        for (int i = 0; i < n; ++i)
        {
            auto* p = new juce::AudioParameterFloat (
                juce::ParameterID ("p" + juce::String (i), 1),
                "Param " + juce::String (i + 1), juce::NormalisableRange<float> (0.0f, 1.0f),
                0.5f);
            params.push_back (p);
            addParameter (p);
        }
    }

    const juce::String getName() const override { return name; }

    void prepareToPlay (double sampleRate, int /*blockSize*/) override
    {
        if (dsp) dsp->setSampleRate (sampleRate);
    }
    void releaseResources() override {}

    bool isBusesLayoutSupported (const BusesLayout& layouts) const override
    {
        const auto out = layouts.getMainOutputChannelSet();
        return (out == juce::AudioChannelSet::mono() || out == juce::AudioChannelSet::stereo())
            && layouts.getMainInputChannelSet() == out;
    }

    void processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override
    {
        juce::ScopedNoDenormals noDenormals;
        if (! dsp) return;

        for (size_t i = 0; i < params.size(); ++i)
            dsp->setParam ((int) i, params[i]->get());

        // Tempo-synced FX (FreqShiftEcho echo div, SimpleSide pump) need transport.
        if (auto* ph = getPlayHead())
            if (auto pos = ph->getPosition())
            {
                const double bpm     = pos->getBpm().orFallback (120.0);
                const double timeSec = pos->getTimeInSeconds().orFallback (0.0);
                dsp->setTransport (60.0 / juce::jmax (1.0e-6, bpm), timeSec);
            }

        const int frames = buffer.getNumSamples();
        if (buffer.getNumChannels() == 1)
        {
            // DSP is stereo; mirror mono in a scratch L/R then fold back to mono.
            scratch.setSize (2, frames, false, false, true);
            scratch.copyFrom (0, 0, buffer, 0, 0, frames);
            scratch.copyFrom (1, 0, buffer, 0, 0, frames);
            float* ch[2] = { scratch.getWritePointer (0), scratch.getWritePointer (1) };
            dsp->process (ch, ch, frames);
            buffer.copyFrom (0, 0, scratch, 0, 0, frames);
            buffer.applyGain (0, 0, frames, 0.5f);
            buffer.addFrom (0, 0, scratch, 1, 0, frames, 0.5f);
        }
        else
        {
            float* ch[2] = { buffer.getWritePointer (0), buffer.getWritePointer (1) };
            dsp->process (ch, ch, frames);
        }
    }

    // --- state: a flat little-endian float array of the param values, matching the
    // engine's `casperakiFxParams` / AirWindows `state` chunk semantics ---
    void getStateInformation (juce::MemoryBlock& dest) override
    {
        dest.reset();
        for (auto* p : params) { float v = p->get(); dest.append (&v, sizeof (float)); }
    }
    void setStateInformation (const void* data, int size) override
    {
        const int n = juce::jmin ((int) params.size(), size / (int) sizeof (float));
        auto* f = static_cast<const float*> (data);
        for (int i = 0; i < n; ++i) params[i]->setValueNotifyingHost (juce::jlimit (0.0f, 1.0f, f[i]));
    }

    double getTailLengthSeconds() const override { return 4.0; } // echo/reverb ring-out
    bool acceptsMidi() const override  { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }

    juce::AudioProcessorEditor* createEditor() override { return new juce::GenericAudioProcessorEditor (*this); }
    bool hasEditor() const override { return true; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

private:
    juce::String name;
    std::unique_ptr<casperaki::aw::Plugin> dsp;
    std::vector<juce::AudioParameterFloat*> params;
    juce::AudioBuffer<float> scratch;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (AwProcessor)
};
