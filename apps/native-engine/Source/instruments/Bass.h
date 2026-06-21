//
// Created by Tiago Alves on 15/05/2022.
//

#pragma once

#include "TonalInstrument.h"
//#include "SamplesDownloadTask.cpp"
#include "SequencerUtils.h"

class Bass : public TonalInstrument
{
public:
    Bass (te::Edit &edit, const j::var &instrumentData, juce::String baseURL) : TonalInstrument (edit, instrumentData, baseURL)
    {
        sampleData = instrumentData["samples"];

        initPlugins();
    }
    
    ~Bass()
    {
        longIds.reset();
        shortIds.reset();
    }

    j::Array<te::AudioTrack*> getAudioTracks() override
    {
        return j::Array<te::AudioTrack*> {shortNotesTrack, longNotesTrack};
    }

    void createSegmentClip (const j::String& segName, const te::TimeRange& segTimeRange,
                            const te::TimeRange& loopTimeRange, const j::Array<TimeNote>& timeNotes, const j::Array<TimeStrums> &timeStrums, const j::var& mute) override
    {
        te::Clip *clip = longNotesTrack->insertNewClip (te::TrackItem::Type::midi, segName, segTimeRange, nullptr);
        auto longNotesMidiClip = dynamic_cast<te::MidiClip *> (clip);
        jassert (longNotesMidiClip != nullptr);
        // loop range is the part that loops, i.e., the length of the instrument patter
        longNotesMidiClip->setLoopRange(loopTimeRange);

        clip = shortNotesTrack->insertNewClip (te::TrackItem::Type::midi, segName, segTimeRange, nullptr);
        auto shortNotesMidiClip = dynamic_cast<te::MidiClip *> (clip);
        jassert (shortNotesMidiClip != nullptr);
        shortNotesMidiClip->setLoopRange (loopTimeRange);

        // docs/58f — bass attack envelope. Pre-e825ad1 ("Disable ADSR;"),
        // bass routed through CasperakiSamplerPlugin with ADSR release=2.0 s
        // on every voice (CasperakiSamplerPlugin.cpp:51–52). The legacy bass
        // long-note tail rang past noteOff for ~2 beats at 120 BPM. After
        // the flip to te::SamplerPlugin (no release stage) bass long notes
        // hard-cut at noteOff. Mirror Synths.h:54 SUSTAIN_TAIL_BEATS as the
        // option-(b) proxy for the legacy ADSR release. Only the long-note
        // branch is extended — short-note samples are recorded staccato by
        // design and never had a release tail in the legacy either.
        static constexpr double SUSTAIN_TAIL_BEATS = 2.0;
        for (auto timeNote: timeNotes)
        {
            if (timeNote.duration > 0.5)
            {
                TimeNote sustained = timeNote;
                sustained.duration += SUSTAIN_TAIL_BEATS;
                addNoteToClip (longNotesMidiClip, sustained, VelocityMode::beat);
            }
            else
            {
                addNoteToClip (shortNotesMidiClip, timeNote, VelocityMode::beat);
            }
        }

        applyMuteToTrack (longNotesTrack, segTimeRange, mute);
        applyMuteToTrack (shortNotesTrack, segTimeRange, mute);
    }

    void initTracks() override
    {
        int currNumTracks = te::getAudioTracks(edit).size();
        edit.ensureNumberOfAudioTracks (currNumTracks + 2);

        longNotesTrack = te::getAudioTracks(edit)[currNumTracks];
        j::String longNotesTrackName = j::String(name);
        longNotesTrackName << "(long notes)";
        longNotesTrack->setName(longNotesTrackName);

        shortNotesTrack = te::getAudioTracks(edit)[currNumTracks + 1];
        j::String shortNotesTrackName = j::String(name);
        shortNotesTrackName << "(short notes)";
        shortNotesTrack->setName(shortNotesTrackName);
        
        jassert (shortNotesTrack != nullptr);
        jassert (longNotesTrack != nullptr);

        longNotesTrack->pluginList.insertPlugin (longNotesSamplerPlugin, 0, nullptr);
        shortNotesTrack->pluginList.insertPlugin (shortNotesSamplerPlugin, 0, nullptr);
    }

private:

    void initPlugins()
    {
        auto samples = sampleData.getArray();
        for (auto sample : *samples) {
            j::DynamicObject::Ptr sampleObj = sample.getDynamicObject();
            if (sampleObj->getProperty("type") == "longNote")
            {
                longIds.get()->setProperty(sampleObj->getProperty("note").toString(), (int)sampleObj->getProperty("id"));
            }
            else
            {
                shortIds.get()->setProperty(sampleObj->getProperty("note").toString(), (int)sampleObj->getProperty("id"));
            }
            sampleObj->clear();
        }
        
        shortNotesSamplerPlugin = edit.getPluginCache().createNewPlugin (SamplerPlugin::xmlTypeName, {});
        longNotesSamplerPlugin = edit.getPluginCache().createNewPlugin (SamplerPlugin::xmlTypeName, {});

        juce::String sampleDownloadURL = generateSampleLoadPath (baseURL);

        SampleDownloader sampleDownloader;
        FileMapPtr sampleLongFiles = sampleDownloader.downloadSamples (
                edit,
                sampleDownloadURL,
                "vstsample",
                longIds
        );
        
        createSampler (sampleLongFiles, true);

        FileMapPtr sampleShortFiles = sampleDownloader.downloadSamples (
                edit,
                sampleDownloadURL,
                "vstsample",
                shortIds
        );
        
        createSampler (sampleShortFiles, false);
        
 //       jassert (shortNotesSamplerPlugin.get() != nullptr);
 //       jassert (longNotesSamplerPlugin.get() != nullptr);

    }
    
    void playNote (std::string noteDataStr) override
    {
        if (shortNotesSamplerPlugin.get() == nullptr)
        {
            DBG ("Short Note Sampler Plugin has not been created");
            return;
        }
        
        if (longNotesSamplerPlugin.get() == nullptr)
        {
            DBG ("Long Note Sampler Plugin has not been created");
            return;
        }
        
        //We obtain a pointer to the SamplerPlugin object
        auto samplerPluginShort = dynamic_cast<SamplerPlugin*> (shortNotesSamplerPlugin.get());
        auto samplerPluginLong = dynamic_cast<SamplerPlugin*> (longNotesSamplerPlugin.get());
    
        juce::var parsedNoteData = juce::JSON::parse (juce::String (noteDataStr));
        auto timeNotes = getRealNotes (parsedNoteData, *new Chord ("C"), *new Chord ("C"));
        
        juce::BigInteger shortKeysHeldDown, longKeysHeldDown;
        samplerPluginShort->playNotes (shortKeysHeldDown); //We let go of all of the keys
        samplerPluginLong->playNotes (longKeysHeldDown);
        
        for (auto timeNote : timeNotes)
        {
            if (timeNote.duration > 0.5)
            {
                longKeysHeldDown.setBit (timeNote.note.midiNote + 12);
            }
            else
            {
                shortKeysHeldDown.setBit (timeNote.note.midiNote + 12);
            }
        }
    
        samplerPluginShort->playNotes (shortKeysHeldDown); //And then we play the new note
        samplerPluginLong->playNotes (longKeysHeldDown);
    }

    void createSampler (FileMapPtr files, bool isLongNotes)
    {
        DBG ("SAMPLES DOWNLOADED FOR " << (isLongNotes? "LONG NOTES" : "SHORT NOTES"));

        // create sampler
        SamplerPlugin* samplerPlugin;
        if (isLongNotes)
        {
            samplerPlugin = dynamic_cast<SamplerPlugin*> (longNotesSamplerPlugin.get());
        }
        else
        {
            samplerPlugin = dynamic_cast<SamplerPlugin*> (shortNotesSamplerPlugin.get());
        }

        jassert (samplerPlugin != nullptr);

        // transform unordered notes into ordered (midi) notes
        std::map<int, j::String> midiNoteFiles {};
        for (auto it = files.get()->begin(); it != files.get()->end(); it++)
        {
            juce::String fullPathName = juce::File::getCurrentWorkingDirectory().getChildFile (it->second).getFullPathName();

//            jassert (juce::File (fullPathName).existsAsFile());
            auto midiNoteNumber = getMidiNoteNumber (it->first);
            midiNoteFiles.insert (std::pair<int, j::String> {midiNoteNumber, fullPathName});
            DBG ("Added note: " << midiNoteNumber );
            
            
            DBG ("This note was added from file: " + fullPathName);
       //     DBG ("But the current working directory is: " + juce::File::getCurrentWorkingDirectory().getFullPathName());
        }

        
        //By this point, samples have been moved to ./samples, relative to the edit directory
        
        int zoneStart = 0, zoneEnd = 0;

        for (auto it = midiNoteFiles.begin(); it != midiNoteFiles.end(); it++)
        {
            DBG( "sorted note: " << it->first << " -> " << it->second );
            
            juce::String fullPathName = it->second;

            const auto error = samplerPlugin->addSound (makeRelative (fullPathName), getMidiNoteName(it->first), 0.0, 0.0, 0.0f);
            jassert (error.isEmpty());

            auto next = std::next(it, 1);
            if (next == midiNoteFiles.end())
            {
                zoneEnd = 180;
            }
            else
            {
                zoneEnd = it->first + (next->first - it->first) / 2;
            }

            samplerPlugin->setSoundParams (samplerPlugin->getNumSounds() - 1, it->first, zoneStart, zoneEnd);
            DBG( "Added sample note: " << it->first << " -> " << zoneStart << "-" << zoneEnd );
            zoneStart = zoneEnd + 1;
        }

        ready = true;
    }

    juce::DynamicObject::Ptr longIds {new juce::DynamicObject()};
    juce::DynamicObject::Ptr shortIds {new juce::DynamicObject()};

    te::AudioTrack *longNotesTrack = nullptr;
    te::AudioTrack *shortNotesTrack = nullptr;

    SamplerPlugin::Ptr longNotesSamplerPlugin;
    SamplerPlugin::Ptr shortNotesSamplerPlugin;

    j::var sampleData;
};

#undef USE_TE_SAMPLER
#undef USE_CASPERAKI_SAMPLER