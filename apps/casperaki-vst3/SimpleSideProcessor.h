// SimpleSideProcessor — a bespoke VST3 wrapper for the tempo-synced volume pump
// (casperaki::aw::makeSimpleSide). The generic AwProcessor can't host it: its DSP
// setParam GROWS a control-point list (pts.resize), so the ACTIVE point count =
// the number of params set, and rawExp values aren't in [0,1]. So:
//   * params carry real ranges (rate, rawExp span beyond [0,1]),
//   * a trailing `numPoints` param records how many control points are active,
//   * processBlock pushes mix/rate + ONLY the active points, so the DSP's pts list
//     ends up the same size as the internal CasperakiSimpleSidePlugin's.
//
// Param layout (matches the engine's casperakiFxParams order, then numPoints):
//   0 = mix [0,1], 1 = rateValue [0,8],
//   2..49 = up to 16 points × (x[0,1], y[0,1], rawExp[-32,32]),
//   50 = numPoints [0,16].
#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include "AwPlugins.h"

class SimpleSideProcessor : public juce::AudioProcessor
{
public:
    static constexpr int kMaxPoints = 16;
    static constexpr int kNumPointParams = kMaxPoints * 3;   // 48
    static constexpr int kNumPointsIdx = 2 + kNumPointParams; // 50

    SimpleSideProcessor (const juce::String& displayName)
        : juce::AudioProcessor (BusesProperties()
              .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
              .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
          name (displayName),
          dsp (casperaki::aw::makeSimpleSide())
    {
        addF (0, "mix",   0.0f, 1.0f, 1.0f);
        addF (1, "rate",  0.0f, 8.0f, 1.0f);
        for (int k = 0; k < kMaxPoints; ++k)
        {
            addF (2 + k * 3 + 0, "x"      + juce::String (k), 0.0f,  1.0f, 0.0f);
            addF (2 + k * 3 + 1, "y"      + juce::String (k), 0.0f,  1.0f, 0.0f);
            addF (2 + k * 3 + 2, "rawExp" + juce::String (k), -32.0f, 32.0f, 0.0f);
        }
        addF (kNumPointsIdx, "numPoints", 0.0f, (float) kMaxPoints, 0.0f);
    }

    const juce::String getName() const override { return name; }
    void prepareToPlay (double sr, int) override { if (dsp) dsp->setSampleRate (sr); }
    void releaseResources() override {}

    bool isBusesLayoutSupported (const BusesLayout& l) const override
    {
        const auto o = l.getMainOutputChannelSet();
        return (o == juce::AudioChannelSet::mono() || o == juce::AudioChannelSet::stereo())
            && l.getMainInputChannelSet() == o;
    }

    void processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override
    {
        juce::ScopedNoDenormals nd;
        if (! dsp) return;

        dsp->setParam (0, params[0]->get());
        dsp->setParam (1, params[1]->get());
        const int np = juce::jlimit (0, kMaxPoints, (int) std::lround (params[kNumPointsIdx]->get()));
        for (int k = 0; k < np; ++k)
            for (int c = 0; c < 3; ++c)
                dsp->setParam (2 + k * 3 + c, params[(size_t) (2 + k * 3 + c)]->get());

        if (auto* ph = getPlayHead())
            if (auto pos = ph->getPosition())
                dsp->setTransport (60.0 / juce::jmax (1.0e-6, pos->getBpm().orFallback (120.0)),
                                   pos->getTimeInSeconds().orFallback (0.0));

        const int n = buffer.getNumSamples();
        if (buffer.getNumChannels() >= 2)
        {
            float* ch[2] = { buffer.getWritePointer (0), buffer.getWritePointer (1) };
            dsp->process (ch, ch, n);
        }
        else if (buffer.getNumChannels() == 1)
        {
            scratch.setSize (2, n, false, false, true);
            scratch.copyFrom (0, 0, buffer, 0, 0, n);
            scratch.copyFrom (1, 0, buffer, 0, 0, n);
            float* ch[2] = { scratch.getWritePointer (0), scratch.getWritePointer (1) };
            dsp->process (ch, ch, n);
            buffer.copyFrom (0, 0, scratch, 0, 0, n);
        }
    }

    void getStateInformation (juce::MemoryBlock& dest) override
    {
        dest.reset();
        for (auto* p : params) { float v = p->get(); dest.append (&v, sizeof (float)); }
    }
    void setStateInformation (const void* data, int size) override
    {
        const int n = juce::jmin ((int) params.size(), size / (int) sizeof (float));
        auto* f = static_cast<const float*> (data);
        for (int i = 0; i < n; ++i)
            params[(size_t) i]->setValueNotifyingHost (params[(size_t) i]->getNormalisableRange().convertTo0to1 (f[i]));
    }

    double getTailLengthSeconds() const override { return 0.0; }
    bool acceptsMidi() const override { return false; }
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
    void addF (int idx, const juce::String& id, float lo, float hi, float def)
    {
        auto* p = new juce::AudioParameterFloat (juce::ParameterID (id, 1), id,
                                                 juce::NormalisableRange<float> (lo, hi), def);
        if ((int) params.size() <= idx) params.resize ((size_t) idx + 1, nullptr);
        params[(size_t) idx] = p;
        addParameter (p);
    }

    juce::String name;
    std::unique_ptr<casperaki::aw::Plugin> dsp;
    std::vector<juce::AudioParameterFloat*> params;
    juce::AudioBuffer<float> scratch;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SimpleSideProcessor)
};
