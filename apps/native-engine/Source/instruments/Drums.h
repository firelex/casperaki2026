//
// Created by Tiago Alves on 06/05/2022.
//

#pragma once

#include "Instrument.h"
#include "SamplesDownloadTask.h"
#include "../FX.h"

class Drums : public Instrument
{
public:

  enum OverrideType {
      all,
      override_bassDrumOnly,
      override_noBassDrum,
      override_bassDrumAndSnareDrumOnly,
      override_hiHatOnly,
      override_bassDrumAndHiHatOnly,
      override_bassDrumSnareDrumAndHiHatOnly,
      override_percussionOnly,
      override_noPercussion,
  };

  static OverrideType getOverrideTypeFromString(j::String typeStr) {
      if (typeStr == "bassDrumOnly")                  return OverrideType::override_bassDrumOnly;
      if (typeStr == "noBassDrum")                    return OverrideType::override_noBassDrum;
      if (typeStr == "bassDrumAndSnareDrumOnly")      return OverrideType::override_bassDrumAndSnareDrumOnly;
      if (typeStr == "hiHatOnly")                     return OverrideType::override_hiHatOnly;
      if (typeStr == "percussionOnly")                return OverrideType::override_percussionOnly;
      if (typeStr == "noPercussion")                  return OverrideType::override_noPercussion;
      if (typeStr == "bassDrumAndHiHatOnly")          return OverrideType::override_bassDrumAndHiHatOnly;
      if (typeStr == "bassDrumSnareDrumAndHiHatOnly") return OverrideType::override_bassDrumSnareDrumAndHiHatOnly;

      return OverrideType::all;
  }

    enum FillType
    {
        none = -1,
        patternFourthBar,
        patternTwelfthBar,
        patternMiddleOfSegment,
        patternEndOfSegment
    };
    
    static FillType getFillTypeFromString(j::String typeStr)
    {
        if (typeStr == "patternFourthBar")          return FillType::patternFourthBar;
        if (typeStr == "patternTwelfthBar")         return FillType::patternTwelfthBar;
        if (typeStr == "patternMiddleOfSegment")    return FillType::patternMiddleOfSegment;
        if (typeStr == "patternEndOfSegment")       return FillType::patternEndOfSegment;

        return FillType::none;
    }

    Drums (te::Edit &edit, const j::var &instrumentData, juce::String baseURL) : Instrument (edit, instrumentData, baseURL)
    {
        try
        {
            for (auto propertyName : instrumentData.getDynamicObject()->getProperties())
            {
                juce::var propertyValue = instrumentData.getDynamicObject()->getProperty(propertyName.name);
                juce::String propertyString = propertyValue.toString(); // Convert each property value to string
                std::cout << propertyName.name.toString().toRawUTF8() << ": " << propertyString << std::endl;
            }

            auto dynamicObj = instrumentData["ids"].getDynamicObject();
            
            if (dynamicObj)
                // 55a port: v8 DynamicObject::clone() returns std::unique_ptr; release to Ptr.
                ids = juce::DynamicObject::Ptr (dynamicObj->clone().release());
            else
            {
                std::cerr << "Could not create instrument " << name << ". JSON ids are NULL. Error: " << std::endl;
                JUCEApplicationBase::quit();
            }
        }
        catch (const std::exception& e)
        {
            std::cerr << "Could not create instrument " << name << ". JSON ids are NULL. Error: " << e.what() << std::endl;
            JUCEApplicationBase::quit();
        }


        // 55a port: v8 DynamicObject::clone() returns std::unique_ptr; release to Ptr.
        subInstruments = juce::DynamicObject::Ptr (instrumentData["subInstruments"].getDynamicObject()->clone().release());

        TRACKTION_LOG( "Drums created!" );

        auto idsProps = ids->getProperties();

        for (auto it = idsProps.begin(); it != idsProps.end(); it++)
        {
            DBG( it->name.toString() << ": " << (int) it->value );
        }

        initPlugins();
    }

    virtual ~Drums()
    {
        ids.reset();
        DBG ("Drums DESTROYED!!!");
    }

    j::Array<te::AudioTrack*> getAudioTracks() override
    {
        return j::Array<te::AudioTrack*> { kicksTrack, snaresTrack, tomsTrack, restTrack };
    }
    
    void processSegment (j::var songData, Instrument *inst, j::String segmentName, te::TimeRange segmentTimeRange, j::Array<j::var>* segmentBars) override
    {
        // get pattern
        j::var pattern = getInstrumentPattern (songData, inst->id);
        if (pattern.isUndefined())
        {
            return;
        }
        
        const j::var override = getInstrumentOverride(songData, inst, segmentName);
        const j::var mute = getInstrumentMute(songData, inst, segmentName);
        const j::var fill = getInstrumentFill(songData, inst, segmentName);

        createSegmentClip (segmentName, segmentTimeRange, segmentBars->size(), pattern, mute, override, fill);
    }
    
    void applyFill (const j::var& fillPattern, int barsCount, FillType fillType = none)
    {
        int patternBarsCount = getPatternBarsCount(fillPattern);

        // if empty pattern, do nothing
        if (patternBarsCount == 0) return;

        int startBar = 0;
        if (fillType == FillType::patternFourthBar)
        {
            if (barsCount < 16) return;
            startBar = 3;
        }
        else if (fillType == FillType::patternTwelfthBar)
        {
            if (barsCount < 16) return;
            startBar = 11;
        }
        else if (fillType == FillType::patternMiddleOfSegment)
        {
            if (barsCount < 8) return;
            startBar = barsCount / 2 - 1;
        }
        else if (fillType == FillType::patternEndOfSegment)
        {
            startBar = std::max (0, barsCount - patternBarsCount);
        }

        applyPattern (fillPattern, startBar, startBar + patternBarsCount );
    }

    void applyPattern (const j::var& drumsPattern, int startBar, int endBar, OverrideType override_type = OverrideType::all)
    {
        int patternBarsCount = getPatternBarsCount(drumsPattern);

        auto isBassDrums = [](j::String subInstrumentName) {
            return subInstrumentName.startsWith ("bassDrum");
        };

        auto isHiHat = [](j::String subInstrumentName) {
            return subInstrumentName.startsWith ("hiHat");
        };

        auto isSnareDrum = [](j::String subInstrumentName) {
            return subInstrumentName.startsWith ("snareDrum");
        };

        auto isPercussion = [](j::String subInstrumentName) {
            return !(
                subInstrumentName.startsWith ("hiHat") ||
                subInstrumentName.startsWith ("crash") ||
                subInstrumentName == "ride" ||
                subInstrumentName == "clap" ||
                subInstrumentName == "snap" ||
                subInstrumentName == "shaker"
            );
        };

        for (auto channelDrumPattern : drumsPattern["pattern"].getDynamicObject()->getProperties())
        {
            j::String subInstrumentName = channelDrumPattern.name.toString();

            switch (override_type) {
                case OverrideType::override_bassDrumOnly:
                    if (!isBassDrums(subInstrumentName)) continue;
                    break;
                case OverrideType::override_bassDrumAndHiHatOnly:
                    if (!isBassDrums(subInstrumentName) && !isHiHat(subInstrumentName)) continue;
                    break;
                case OverrideType::override_noBassDrum:
                    if (isBassDrums(subInstrumentName)) continue;
                    break;
                case OverrideType::override_bassDrumAndSnareDrumOnly:
                    if (!isBassDrums(subInstrumentName) && !isSnareDrum(subInstrumentName)) continue;
                    break;
                case OverrideType::override_bassDrumSnareDrumAndHiHatOnly:
                    if (!isBassDrums(subInstrumentName) && !isHiHat(subInstrumentName) && !isSnareDrum(subInstrumentName)) continue;
                    break;
                case OverrideType::override_hiHatOnly:
                    if (!isHiHat(subInstrumentName)) continue;
                    break;
                case OverrideType::override_percussionOnly:
                    if (!isPercussion(subInstrumentName)) continue;
                    break;
                case OverrideType::override_noPercussion:
                    if (isPercussion(subInstrumentName)) continue;
                    break;
                default:
                    break;
            }

            j::String subInstrumentGroup = (*subInstruments).getProperty(subInstrumentName)["instrumentGroup"].toString();

            te::StepClip *stepClip;

            if (subInstrumentGroup == "kickDrums")
            {
                stepClip = kicksStepClip;
            }
            else if (subInstrumentGroup == "snareDrumsClapSnap")
            {
                stepClip = snaresStepClip;
            }
            else if (subInstrumentGroup == "toms")
            {
                stepClip = tomsStepClip;
            }
            else
            {
                stepClip = restStepClip;
            }

            auto clipPattern = stepClip->getPattern(0);

            j::String songDrumPatternString = channelDrumPattern.value.toString().toLowerCase().retainCharacters("0x-");
            int channelIndex = -1;
            for (int i = 0; i < stepClip->getChannels().size(); i++){
                if (stepClip->getChannels()[i]->name == subInstrumentName) {
                    channelIndex = i;
                    break;
                }
            }

            if (channelIndex == -1)
            {
                DBG ("couldn't find channel for " << subInstrumentName << ". subInstrumentGroup=" << subInstrumentGroup);
                continue;
            }

            for (int currentBar = startBar; currentBar < endBar; currentBar += patternBarsCount)
            {
                for (int i = 0; i <  songDrumPatternString.length(); i++ )
                {
                    const int noteIndex = (currentBar * 32) + i;
                    // don't write past the clip end when (endBar-startBar) isn't
                    // a multiple of patternBarsCount
                    if (noteIndex >= endBar * 32) break;

                    if (songDrumPatternString[i] == 'x')
                    {
                        clipPattern.setNote(channelIndex, noteIndex, true);
                    }
                    else if (songDrumPatternString[i] == '0')
                    {
                        clipPattern.setNote(channelIndex, noteIndex, false);
                    }
                }
            }
        }
    }

    
    void prepareClipForSamplerTrack (tracktion_engine::SamplerPlugin::Ptr _samplerPlugin, te::StepClip* stepClip, te::AudioTrack* track, const j::String& segName, const te::TimeRange& segTimeRange, int barsCount)
    {
        if (_samplerPlugin != nullptr)
        {
            tracktion_engine::SamplerPlugin* samplerPlugin = dynamic_cast<tracktion_engine::SamplerPlugin*> (_samplerPlugin.get());
//            auto clip = track->insertNewClip (te::TrackItem::Type::step, segName, segTimeRange, nullptr);

            auto clipPattern = stepClip->getPattern (0);
            clipPattern.setNumNotes (32 * barsCount);
            clipPattern.setNoteLength (te::BeatDuration::fromBeats (1.0 / 8));

            // remove all channels
            for (int i = stepClip->getChannels().size(); --i >= 0;)
            {
                stepClip->removeChannel(i);
            }

            // create channels according to sampler
            for (int i = 0; i < samplerPlugin->getNumSounds(); i++)
            {
                stepClip->insertNewChannel(i);
                auto soundName = samplerPlugin->getSoundName(i);
                auto channel = stepClip->getChannels()[i];
                channel->noteNumber = getSampleNoteNumber(soundName);
                channel->name = soundName;
            }
        }
    }

    
    void createSegmentClip (const j::String& segName, const te::TimeRange& segTimeRange, int barsCount,
            const j::var& drumsInstrumentPattern, const j::var& mute, const j::var& override, const j::var& fill)
    {
        
        /* We'll initialize clips here, and update them asyncronously */
        
        auto kicksClip = kicksTrack->insertNewClip (te::TrackItem::Type::step, segName, segTimeRange, nullptr);
        kicksStepClip = dynamic_cast<te::StepClip *> (kicksClip);
        auto snaresClip = snaresTrack->insertNewClip (te::TrackItem::Type::step, segName, segTimeRange, nullptr);
        snaresStepClip = dynamic_cast<te::StepClip *> (snaresClip);
        auto tomsClip = tomsTrack->insertNewClip (te::TrackItem::Type::step, segName, segTimeRange, nullptr);
        tomsStepClip = dynamic_cast<te::StepClip *> (tomsClip);
        auto restClip = restTrack->insertNewClip (te::TrackItem::Type::step, segName, segTimeRange, nullptr);
        restStepClip = dynamic_cast<te::StepClip *> (restClip);


        prepareClipForSamplerTrack (kicksSamplerPlugin, kicksStepClip, kicksTrack, segName, segTimeRange, barsCount);
        prepareClipForSamplerTrack (snaresSamplerPlugin, snaresStepClip, snaresTrack, segName, segTimeRange, barsCount);
        prepareClipForSamplerTrack (tomsSamplerPlugin, tomsStepClip, tomsTrack, segName, segTimeRange, barsCount);
        prepareClipForSamplerTrack (restSamplerPlugin, restStepClip, restTrack, segName, segTimeRange, barsCount);


        if ((bool) override && (override["reset"].isBool() && (bool) override["reset"]))
        {
            // apply override pattern
            applyPattern (override, 0, barsCount );
        }
        else
        {
            OverrideType overrideType = OverrideType::all;
            if ((bool) override && (override["type"].isString())) {
                overrideType = getOverrideTypeFromString (override["type"].toString());
            }
            // apply default pattern
            applyPattern (drumsInstrumentPattern, 0, barsCount, overrideType);
        }

        // if has fills, apply fills
        int numFills = 0;
        if (fill.isObject() && fill["patterns"].isObject()) {
            for (auto fillData : fill["patterns"].getDynamicObject()->getProperties()) {
                j::DynamicObject::Ptr patternObject = new j::DynamicObject();
                patternObject->setProperty ("pattern", fillData.value);
                applyFill (j::var (patternObject.get()), barsCount, getFillTypeFromString (fillData.name.toString()));
                numFills++;
            }
        }
        
        DBG ("There are " + juce::String (numFills) + " fills");

        applyMuteToTrack (kicksTrack, segTimeRange, mute);
        applyMuteToTrack (restTrack, segTimeRange, mute);
        applyMuteToTrack (snaresTrack, segTimeRange, mute);
        applyMuteToTrack (tomsTrack, segTimeRange, mute);
    }

    int getPatternBarsCount (j::var drumsInstrumentPattern) override
    {
        auto drumsPattern = drumsInstrumentPattern["pattern"];
        
        if (drumsPattern.getDynamicObject() == nullptr) return 0;
            
        if (drumsPattern.getDynamicObject()->getProperties().size() == 0) return 0;
        auto firstDrumsPatternValue = drumsPattern.getDynamicObject()->getProperties().begin()->value.toString().toLowerCase().retainCharacters("0x-");
        return (int)std::ceil(firstDrumsPatternValue.length() / 32.0);
    }
    
    void initClips() override
    {
        /* We'll initialize clips here, and update them asyncronously */
        if (kicksSamplerPlugin != nullptr)
        {
            kicksTrack->insertNewClip (te::TrackItem::Type::step, "Kick", te::timeRangeFromSamples (juce::Range<int64_t> (0, 44100), 44100), nullptr);
            kicksStepClip = dynamic_cast<te::StepClip*> (kicksTrack->getClips()[0]);
        }
                
        if (snaresSamplerPlugin != nullptr)
        {
            snaresTrack->insertNewClip (te::TrackItem::Type::step, "Snare", te::timeRangeFromSamples (juce::Range<int64_t> (0, 44100), 44100), nullptr);
            snaresStepClip = dynamic_cast<te::StepClip*> (snaresTrack->getClips()[0]);
        }
        
        if (tomsSamplerPlugin != nullptr)
        {
            tomsTrack->insertNewClip (te::TrackItem::Type::step, "Toms", te::timeRangeFromSamples (juce::Range<int64_t> (0, 44100), 44100), nullptr);
            tomsStepClip = dynamic_cast<te::StepClip*> (tomsTrack->getClips()[0]);
        }
        
        if (restSamplerPlugin != nullptr)
        {
            restTrack->insertNewClip (te::TrackItem::Type::step, "emptyRestSegment", te::timeRangeFromSamples (juce::Range<int64_t> (0, 44100), 44100), nullptr);
            restStepClip = dynamic_cast<te::StepClip*> (restTrack->getClips()[0]);
        }
    }

    void initTracks() override
    {
        int currNumTracks = te::getAudioTracks(edit).size();
        
        edit.ensureNumberOfAudioTracks (currNumTracks + 4);

        kicksTrack = te::getAudioTracks(edit)[currNumTracks];
        kicksTrack->setName(name + "-kicks");
        kicksTrack->getVolumePlugin()->setVolumeDb (defaultVolume);
        jassert(kicksSamplerPlugin != nullptr);
        kicksTrack->pluginList.insertPlugin(kicksSamplerPlugin, 0, nullptr);

        snaresTrack = te::getAudioTracks(edit)[currNumTracks + 1];
        snaresTrack->setName(name + "-snares");
        snaresTrack->getVolumePlugin()->setVolumeDb (defaultVolume);
        jassert(snaresSamplerPlugin != nullptr);
        snaresTrack->pluginList.insertPlugin(snaresSamplerPlugin, 0, nullptr);

        tomsTrack = te::getAudioTracks(edit)[currNumTracks + 2];
        tomsTrack->setName(name + "-toms");
        tomsTrack->getVolumePlugin()->setVolumeDb (defaultVolume);
        jassert(tomsSamplerPlugin != nullptr);
        tomsTrack->pluginList.insertPlugin(tomsSamplerPlugin, 0, nullptr);

        restTrack = te::getAudioTracks(edit)[currNumTracks + 3];
        restTrack->setName(name + "-rest");
        restTrack->getVolumePlugin()->setVolumeDb (defaultVolume);
        jassert (restSamplerPlugin != nullptr);
        restTrack->pluginList.insertPlugin(restSamplerPlugin, 0, nullptr);
    }

    void setInstrumentTargetVolumes (juce::String genre)
    {
        DBG ("===========================================================================================");
        DBG ("Setting drum target volumes:");
        auto plugins = juce::Array<te::Plugin::Ptr>{kicksSamplerPlugin, snaresSamplerPlugin, tomsSamplerPlugin, restSamplerPlugin};
        for (auto plugin: plugins)
        {
            auto samplerPlugin = dynamic_cast<tracktion_engine::SamplerPlugin *>(plugin.get ());
            for (int i = 0; i < samplerPlugin->getNumSounds (); i++)
            {
                auto soundName = samplerPlugin->getSoundName (i);
                auto lowLevelType = (*subInstruments).getProperty (soundName)["lowLevelType"].toString ();
                double targetVolume = FX::getInstrumentTargetVolume (lowLevelType, genre);
                DBG(soundName + " lowLevelType: " + lowLevelType + " volume: " + juce::String{targetVolume});
                samplerPlugin->setSoundGains (i, (float) targetVolume, 0);
            }
        }

    }

private:

    void initPlugins()
    {
        kicksSamplerPlugin = edit.getPluginCache().createNewPlugin (tracktion_engine::SamplerPlugin::xmlTypeName, {});
        jassert (kicksSamplerPlugin != nullptr);

        snaresSamplerPlugin = edit.getPluginCache().createNewPlugin(tracktion_engine::SamplerPlugin::xmlTypeName, {});
        jassert(snaresSamplerPlugin != nullptr);

        tomsSamplerPlugin = edit.getPluginCache().createNewPlugin(tracktion_engine::SamplerPlugin::xmlTypeName, {});
        jassert(tomsSamplerPlugin != nullptr);

        restSamplerPlugin = edit.getPluginCache().createNewPlugin(tracktion_engine::SamplerPlugin::xmlTypeName, {});
        jassert(restSamplerPlugin != nullptr);
        
        
        juce::String sampleDownloadURL = generatePath (baseURL, "playSample/");
        
        DBG ("Drum sample Download URL is: " + sampleDownloadURL);

        SampleDownloader sampleDownloader;
        FileMapPtr sampleFiles = sampleDownloader.downloadSamples (
                edit,
                sampleDownloadURL,
                j::String ("playsample"),
                ids
        );

        createSampler (sampleFiles);
    }

    void createSampler (FileMapPtr files)
    {
        DBG( "DRUMS SAMPLES DOWNLOADED!!!! " << (int) files->size() );

        for (auto it = files.get()->begin(); it != files.get()->end(); it++)
        {
            juce::String fullPathName = juce::File::getCurrentWorkingDirectory().getChildFile (it->second).getFullPathName();
            DBG (fullPathName);
//            jassert (juce::File (fullPathName).existsAsFile());

            j::String subInstrumentGroup = (*subInstruments).getProperty(it->first)["instrumentGroup"].toString();

            tracktion_engine::SamplerPlugin* samplerPlugin;
            if (subInstrumentGroup == "kickDrums") {
                samplerPlugin = dynamic_cast<tracktion_engine::SamplerPlugin*> (kicksSamplerPlugin.get());
            } else if (subInstrumentGroup == "snareDrumsClapSnap") {
                samplerPlugin = dynamic_cast<tracktion_engine::SamplerPlugin*> (snaresSamplerPlugin.get());
            } else if (subInstrumentGroup == "toms") {
                samplerPlugin = dynamic_cast<tracktion_engine::SamplerPlugin*> (tomsSamplerPlugin.get());
            } else {
                samplerPlugin = dynamic_cast<tracktion_engine::SamplerPlugin*> (restSamplerPlugin.get());
            }
            
            jassert (samplerPlugin!= nullptr);
            
            int noteNumber = getSampleNoteNumber (it->first);
            double preshift = ((*subInstruments).getProperty(it->first).hasProperty("preshift"))
                    ? (double)((*subInstruments).getProperty(it->first)["preshift"])
                    : 0.0;

            const auto error = samplerPlugin->addSound (makeRelative (fullPathName), it->first, -preshift, 0.0, 0.0f);
            jassert (error.isEmpty());
            int index = samplerPlugin->getNumSounds() - 1;
            samplerPlugin->setSoundParams (index, noteNumber, noteNumber, noteNumber);
            samplerPlugin->setSoundOpenEnded (index, true);
        }

        ready = true;
    }

    int getSampleNoteNumber(j::String sampleName) {
        int index = ids->getProperties().indexOf(sampleName);
        return 48 + index * 2;
    }

    void prepareClip (te::StepClip *pClip, tracktion_engine::SamplerPlugin::Ptr _samplerPlugin) {
        // forward to the raw-pointer overload (identical body)
        prepareClip (pClip, dynamic_cast<tracktion_engine::SamplerPlugin *>(_samplerPlugin.get()));
    }

    void prepareClip (te::StepClip *pClip, tracktion_engine::SamplerPlugin* samplerPlugin)
    {
        // remove all channels
        for (int i = pClip->getChannels().size(); --i >= 0;) {
            pClip->removeChannel(i);
        }

        // create channels according to sampler
        for (int i = 0; i < samplerPlugin->getNumSounds(); i++){
            pClip->insertNewChannel(i);
            auto soundName = samplerPlugin->getSoundName(i);
            auto channel = pClip->getChannels()[i];
            channel->noteNumber = getSampleNoteNumber(soundName);
            channel->name = soundName;
        }
    }
    
    void playNote (std::string noteDataStr) override
    {
        //We obtain a pointer to the SamplerPlugin object
        auto samplerKicks = dynamic_cast<tracktion_engine::SamplerPlugin*> (kicksSamplerPlugin.get());
        auto samplerSnares = dynamic_cast<tracktion_engine::SamplerPlugin*> (snaresSamplerPlugin.get());
        auto samplerToms = dynamic_cast<tracktion_engine::SamplerPlugin*> (tomsSamplerPlugin.get());
        auto samplerRest = dynamic_cast<tracktion_engine::SamplerPlugin*> (restSamplerPlugin.get());
    
        juce::var parsedNoteData = juce::JSON::parse (juce::String (noteDataStr));
        auto noteStr = parsedNoteData.getProperty ("note", juce::var());
        
        juce::BigInteger keysHeldDown;
        
        samplerKicks->playNotes (keysHeldDown); //We stop pressing the keys
        samplerSnares->playNotes (keysHeldDown);
        samplerToms->playNotes (keysHeldDown);
        samplerRest->playNotes (keysHeldDown);
        
        keysHeldDown.setBit (getSampleNoteNumber (juce::String (noteStr.toString())));
        
        samplerKicks->playNotes (keysHeldDown); //And then we play the new note
        samplerSnares->playNotes (keysHeldDown);
        samplerToms->playNotes (keysHeldDown);
        samplerRest->playNotes (keysHeldDown);
    }

    juce::DynamicObject::Ptr ids;
    juce::DynamicObject::Ptr subInstruments;
public:
    
    te::AudioTrack *kicksTrack = nullptr;
    te::AudioTrack *snaresTrack = nullptr;
    te::AudioTrack *tomsTrack = nullptr;
    te::AudioTrack *restTrack = nullptr;
    tracktion_engine::SamplerPlugin::Ptr kicksSamplerPlugin;
    tracktion_engine::SamplerPlugin::Ptr snaresSamplerPlugin;
    tracktion_engine::SamplerPlugin::Ptr tomsSamplerPlugin;
    tracktion_engine::SamplerPlugin::Ptr restSamplerPlugin;
    
    te::StepClip *kicksStepClip = nullptr, *restStepClip = nullptr, *snaresStepClip = nullptr, *tomsStepClip = nullptr;
};
