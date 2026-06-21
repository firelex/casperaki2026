//
// Created by Tiago Alves on 06/05/2022.
//

#pragma once

#include "Instrument.h"
#include "SamplesDownloadTask.h"

class TransitionPattern : public Instrument
{
    
public:
    TransitionPattern (te::Edit &edit, const j::var &instrumentData, juce::String baseURL) : Instrument(edit, instrumentData, baseURL) {

        for (auto sampleData : *(instrumentData["samples"].getArray()))
        {
            auto sampleObj = sampleData.getDynamicObject();
            ids->setProperty(sampleObj->getProperty("note").toString(), (int)sampleObj->getProperty("id"));
        }

        isSample = instrumentData["sampleOrVst"].toString().equalsIgnoreCase("sample");

        DBG( "TransitionPattern created!" );

        auto idsProps = ids->getProperties();
        for (auto it = idsProps.begin(); it != idsProps.end(); it++) {
            DBG( it->name.toString() << ": " << (int) it->value );
        }

        initPlugins();
    }

    virtual ~TransitionPattern()
    {
        ids.reset();
        DBG("TransitionPattern DESTROYED!!!");
    }

    j::Array<te::AudioTrack*> getAudioTracks() override {
        return j::Array<te::AudioTrack*>{track};
    }
    
    void processSegment (j::var songData, Instrument *inst, j::String segmentName, te::TimeRange segmentTimeRange, j::var transitionData) override
    {
        if (!(bool) transitionData) return;

        auto instrument = dynamic_cast<TransitionPattern *> (inst);
        if (instrument == nullptr) {
            DBG("Instrument " << inst->id << " is not TransitionPattern!");
            return;
        }

        instrument->createSegmentClip(segmentName, segmentTimeRange, transitionData);
    }

    void createSegmentClip(const j::String& segName, const te::TimeRange& segmentTimeRange, const j::var& transitionData)
    {
        int barsCount = getPatternBarsCount(transitionData["config"]["details"]);

        // if empty pattern, do nothing
        if (barsCount == 0) return;

        te::BeatRange clipBeatRange{
                edit.tempoSequence.toBeats(segmentTimeRange.getStart()) + te::BeatDuration::fromBeats((int) transitionData["sequenceStartPosition"] / 8.0),
                te::BeatDuration::fromBeats(barsCount * 4)
        };

        te::TimeDuration clipOffset = te::TimeDuration::fromSeconds((double)transitionData["sequenceStartPositionOffsetInSeconds"]);

        te::TimeRange playTimeRange = edit.tempoSequence.toTime(clipBeatRange);
        playTimeRange.movedToStartAt(playTimeRange.getStart() + clipOffset);

        te::Clip *clip = track->insertNewClip (te::TrackItem::Type::step, segName, playTimeRange, nullptr);
        auto stepClip = dynamic_cast<te::StepClip *> (clip);

        auto clipPattern = stepClip->getPattern(0);
        clipPattern.setNumNotes(32 * barsCount);
        clipPattern.setNoteLength(te::BeatDuration::fromBeats(1.0/8));
        prepareClip(stepClip);

        // apply pattern

        int channelIndex = 0;
        for (auto channelDrumPattern : transitionData["config"]["details"]["pattern"].getDynamicObject()->getProperties()) {
            j::String songDrumPatternString = channelDrumPattern.value.toString().toLowerCase().retainCharacters("0x");

            for (int i = 0; i <  songDrumPatternString.length(); i++ ) {
                if (songDrumPatternString[i] == 'x'){
                    clipPattern.setNote(channelIndex, i, true);
                }
            }

            channelIndex++;
        }
    }

    int getPatternBarsCount(j::var drumsInstrumentPattern) override {
        auto drumsPattern = drumsInstrumentPattern["pattern"];
        if (drumsPattern.getDynamicObject()->getProperties().size() == 0) return 0;
        auto firstDrumsPatternValue = drumsPattern.getDynamicObject()->getProperties().begin()->value.toString().toLowerCase().retainCharacters("0x");
        return firstDrumsPatternValue.length() / 32;
    }

    void initTracks() override {
        int currNumTracks = te::getAudioTracks(edit).size();
        edit.ensureNumberOfAudioTracks(currNumTracks + 1);

        track = te::getAudioTracks(edit)[currNumTracks];
        track->setName(name);

        track->getVolumePlugin()->setVolumeDb(defaultVolume);

        track->pluginList.insertPlugin(samplerPlugin, 0, nullptr);
    }

private:

    void initPlugins()
    {
        juce::String sampleLoadPath;
        juce::String sampleFilePrefix;
        
        if (!isSample)
        {
            sampleLoadPath = generateSampleLoadPath (baseURL);
            sampleFilePrefix = "vstsample";
        }
        else
        {
            sampleLoadPath = generateSamplePlayPath (baseURL);
            sampleFilePrefix = "playsample";
        }
        
        SampleDownloader sampleDownloader;
        FileMapPtr sampleFiles = sampleDownloader.downloadSamples (
                edit,
                sampleLoadPath,
                sampleFilePrefix,
                ids
        );

        createSampler (sampleFiles);
    }

    void createSampler (FileMapPtr files)
    {
        DBG ("TransitionPattern SAMPLES DOWNLOADED!!!!");
        // init sampler
        samplerPlugin = edit.getPluginCache().createNewPlugin(tracktion_engine::SamplerPlugin::xmlTypeName, {});
        jassert (samplerPlugin != nullptr);

        tracktion_engine::SamplerPlugin* castSamplerPlugin = dynamic_cast<tracktion_engine::SamplerPlugin*>(samplerPlugin.get());

        for (auto it = files.get()->begin(); it != files.get()->end(); it++) {

            juce::String fullPathName = juce::File::getCurrentWorkingDirectory().getChildFile (it->second).getFullPathName();
            int noteNumber = getSampleNoteNumber (it->first);
            const auto error = castSamplerPlugin->addSound (makeRelative (fullPathName), it->first, 0.0, 0.0, 0.0f);
            jassert (error.isEmpty());
            int index = castSamplerPlugin->getNumSounds() - 1;
            castSamplerPlugin->setSoundParams (index, noteNumber, noteNumber, noteNumber);
            castSamplerPlugin->setSoundOpenEnded (index, true);
        }

        ready = true;
    }

    int getSampleNoteNumber (j::String sampleName) { return getMidiNoteNumber (sampleName); }

    void prepareClip (te::StepClip *pClip)
    {
        // remove all channels
        for (int i = pClip->getChannels().size(); --i >= 0;) {
            pClip->removeChannel(i);
        }

        tracktion_engine::SamplerPlugin* castSamplerPlugin = dynamic_cast<tracktion_engine::SamplerPlugin*>(samplerPlugin.get());

        // create channels according to sampler
        for (int i = 0; i < castSamplerPlugin->getNumSounds(); i++){
            pClip->insertNewChannel(i);
            auto soundName = castSamplerPlugin->getSoundName(i);
            auto channel = pClip->getChannels()[i];
            channel->noteNumber = getSampleNoteNumber(soundName);
            channel->name = soundName;
        }
    }

    juce::DynamicObject::Ptr ids {new j::DynamicObject};
    bool isSample;

    te::AudioTrack *track;
    tracktion_engine::SamplerPlugin::Ptr samplerPlugin;
};

