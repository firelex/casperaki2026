//
// Created by Tiago Alves on 22/06/2022.
//

#pragma once

#include "Instrument.h"
#include "SamplesDownloadTask.h"

class TransitionNoise: public Instrument
{
public:
    TransitionNoise (te::Edit &edit, const j::var &instrumentData, juce::String baseURL) : Instrument (edit, instrumentData, baseURL)
    {
        defaultVolume = 0;

        // frequencyStart is read per-segment from transitionData in
        // createSegmentClip; validate its presence in details but don't store it.
        auto detailsData = instrumentData["details"];
        jassert (detailsData.hasProperty ("frequencyStart"));
    }

    virtual ~TransitionNoise()
    {
        DBG("TransitionNoise DESTROYED!!!");
    }

    j::Array<te::AudioTrack*> getAudioTracks() override
    {
        return j::Array<te::AudioTrack*>{track};
    }

    void createSegmentClip (const j::String& segName, const te::TimeRange& segmentTimeRange, const j::var& transitionData)
    {
        te::TimePosition sequenceStartPosition = edit.tempoSequence.toTime( te::BeatPosition::fromBeats( (double)transitionData["sequenceStartPosition"]/8.0 ) );
        sequenceStartPosition = sequenceStartPosition + te::TimeDuration::fromSeconds((double)transitionData["sequenceStartPositionOffsetInSeconds"]);

        double attackDuration = transitionData["attackDuration"];
        double decaySequenceStartPositionOffsetInSeconds = transitionData["decaySequenceStartPositionOffsetInSeconds"];
        double decayDuration = transitionData["decayDuration"];

        int frequencyStart = transitionData["frequencyStart"];
        int frequencyEnd = transitionData["frequencyEnd"];
        float volumeAttack = te::decibelsToVolumeFaderPosition(transitionData["volumeAttack"]);
        float volumeSustain = te::decibelsToVolumeFaderPosition(transitionData["volumeSustain"]);
        float volumeDecay = te::decibelsToVolumeFaderPosition(transitionData["volumeDecay"]);

        // add MIDI clip with single note to play the White Noise
        te::TimePosition clipStart = te::TimePosition::fromSeconds(segmentTimeRange.getStart().inSeconds() + sequenceStartPosition.inSeconds());
        tracktion::TimeRange playTimeRange{
                clipStart,
                tracktion::TimeDuration::fromSeconds(decaySequenceStartPositionOffsetInSeconds + decayDuration)
        };

        te::Clip *clip = track->insertNewClip (te::TrackItem::Type::midi, segName, playTimeRange, nullptr);
        auto notesMidiClip = dynamic_cast<te::MidiClip *> (clip);
        jassert(notesMidiClip != nullptr);
        auto notesSequence = &notesMidiClip->getSequence();
        te::BeatDuration noteDuration = te::BeatDuration::fromBeats(
                (decaySequenceStartPositionOffsetInSeconds + decayDuration) * edit.tempoSequence.getBeatsPerSecondAt (segmentTimeRange.getStart())
        );
        notesSequence->addNote(48, te::BeatPosition::fromBeats(0.0), noteDuration, 100, 1, nullptr); // add a C1 for the duration of the noise

        // add volume ramps
        te::AutomatableParameter::Ptr volParam = track->getVolumePlugin()->getAutomatableParameterByID("volume");
        te::AutomationCurve curve = volParam->getCurve();
        curve.addPoint(clipStart, volumeAttack, 0);
        curve.addPoint(clipStart + te::TimeDuration::fromSeconds(attackDuration), volumeSustain, 0);
        curve.addPoint(clipStart + te::TimeDuration::fromSeconds( decaySequenceStartPositionOffsetInSeconds), volumeSustain, 0);
        curve.addPoint(clipStart + te::TimeDuration::fromSeconds( decaySequenceStartPositionOffsetInSeconds + decayDuration), volumeDecay, 0);
        curve.addPoint(clipStart + te::TimeDuration::fromSeconds( decaySequenceStartPositionOffsetInSeconds + decayDuration), volumeAttack, 0);

        // add LP filter freq ramp (exponential. curvature ~0.5)
        te::AutomatableParameter::Ptr freqParam = dynamic_cast<te::LowPassPlugin*>(lowPassPlugin.get())->frequency;
        te::AutomationCurve freqCurve = freqParam->getCurve();
        freqCurve.addPoint(clipStart, frequencyStart, 0.5);
        freqCurve.addPoint(clipStart + te::TimeDuration::fromSeconds(attackDuration), frequencyEnd, 0);
        freqCurve.addPoint(clipStart + te::TimeDuration::fromSeconds(decaySequenceStartPositionOffsetInSeconds + decayDuration), frequencyEnd, 0);
        freqCurve.addPoint(clipStart + te::TimeDuration::fromSeconds(decaySequenceStartPositionOffsetInSeconds + decayDuration), frequencyStart, 0);
    }

    int getPatternBarsCount (j::var) override
    {
        jassertfalse; // should never be used
        return 0;
    }

    void initTracks() override
    {
        initPlugins();

        int currNumTracks = te::getAudioTracks (edit).size();
        edit.ensureNumberOfAudioTracks (currNumTracks + 1);

        track = te::getAudioTracks (edit)[currNumTracks];
        track->setName (name);

        track->pluginList.insertPlugin (lowPassPlugin, 0, nullptr);
        track->pluginList.insertPlugin (whiteNoisePlugin, 0, nullptr);
    }

    void processSegment (j::var songData, Instrument *inst, j::String segmentName, te::TimeRange segmentTimeRange, j::var transitionData) override
    {
        if (!(bool) transitionData) return;

        auto instrument = dynamic_cast<TransitionNoise*> (inst);
        if (instrument == nullptr)
        {
            DBG("Instrument " << inst->id << " is not TransitionNoise!");
            return;
        }

        instrument->createSegmentClip (segmentName, segmentTimeRange, transitionData);
    }

    void initPlugins()
    {
        //==============================================================================
        // add Low Pass plugin
        lowPassPlugin = edit.getPluginCache().createNewPlugin (te::LowPassPlugin::xmlTypeName, {});
        jassert(lowPassPlugin != nullptr);

        //==============================================================================
        // add 4OSC plugin with White Noise
        j::String whiteNoisePreset = "  <PLUGIN type=\"4osc\" windowLocked=\"1\" id=\"1242\" enabled=\"1\" windowX=\"1060\"\n"
                                     "          windowY=\"395\" filterType=\"1\" tune1=\"0.0\" fineTune1=\"0.0\" level1=\"0.0\"\n"
                                     "          pulseWidth1=\"0.5\" detune1=\"0.0\" spread1=\"0.0\" pan1=\"0.0\" fineTune2=\"0.0\"\n"
                                     "          level2=\"0.0\" pulseWidth2=\"0.5\" detune2=\"0.0\" spread2=\"0.0\" pan2=\"0.0\"\n"
                                     "          fineTune3=\"0.0\" level3=\"0.0\" pulseWidth3=\"0.5\" fineTune4=\"0.0\"\n"
                                     "          level4=\"0.0\" pulseWidth4=\"0.5\" lfoRate1=\"1.0\" lfoDepth1=\"1.0\"\n"
                                     "          lfoRate2=\"1.0\" lfoDepth2=\"1.0\" modAttack1=\"0.0\" modDecay1=\"60.0\"\n"
                                     "          modSustain1=\"64.39393615722656\" modRelease1=\"60.0\" modAttack2=\"0.1000000014901161\"\n"
                                     "          modDecay2=\"0.1000000014901161\" modSustain2=\"80.0\" modRelease2=\"0.1000000014901161\"\n"
                                     "          ampAttack=\"0.1000000014901161\" ampDecay=\"0.1000000014901161\"\n"
                                     "          ampSustain=\"80.0\" ampRelease=\"0.1000000014901161\" ampVelocity=\"100.0\"\n"
                                     "          filterAttack=\"0.0\" filterDecay=\"2.565308094024658\" filterSustain=\"100.0\"\n"
                                     "          filterRelease=\"60.0\" filterFreq=\"43.65420913696289\" filterResonance=\"0.5\"\n"
                                     "          filterAmount=\"1.0\" filterKey=\"0.0\" filterVelocity=\"0.0\" reverbSize=\"0.0\"\n"
                                     "          reverbWidth=\"0.0\" reverbMix=\"0.0\" delayFeedback=\"-10.0\" delayCrossfeed=\"-100.0\"\n"
                                     "          delayMix=\"0.0\" chosusSpeed=\"1.0\" chorusDepth=\"3.0\" chorusMix=\"0.0\"\n"
                                     "          legato=\"0.0\" masterLevel=\"0.0\" waveShape1=\"5\">\n"
                                     "    <MACROPARAMETERS id=\"1243\"/>\n"
                                     "    <MODIFIERASSIGNMENTS/>\n"
                                     "    <MODMATRIX/>\n"
                                     "  </PLUGIN>";


        if (whiteNoisePlugin = edit.getPluginCache().createNewPlugin(te::FourOscPlugin::xmlTypeName, {}))
        {
            if (auto e = j::parseXML(whiteNoisePreset))
            {
                auto vt = j::ValueTree::fromXml(*e);

                if (vt.isValid())
                    whiteNoisePlugin->restorePluginStateFromValueTree(vt);
            }
        }
        else jassertfalse;
    }

    private:

    te::FourOscPlugin::Ptr whiteNoisePlugin;
    te::LowPassPlugin::Ptr lowPassPlugin;

    te::AudioTrack *track = nullptr;
};

