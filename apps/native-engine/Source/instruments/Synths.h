//
// Created by Tiago Alves on 15/05/2022.
//

#pragma once

#include "TonalInstrument.h"
//#include "SamplesDownloadTask.cpp"
#include "SequencerUtils.h"



class Synths : public TonalInstrument
{
public:
    Synths(te::Edit& edit, const j::var& instrumentData, juce::String baseURL)
        : TonalInstrument(edit, instrumentData, baseURL)
    {
        sampleData = instrumentData["samples"];

        initPlugins();
    }

    ~Synths()
    {

    }

    j::Array<te::AudioTrack*> getAudioTracks() override
    {
        return j::Array<te::AudioTrack*> {track};
    }

    // docs/58a — piano-sustain audit. Commit e825ad1 ("Disable ADSR;",
    // 2023-11-30) flipped the active sampler from CasperakiSamplerPlugin
    // (ADSR release=2.0 s + openEnded let-ring) to te::SamplerPlugin
    // (hard-cut at noteEnd, no release stage). Result: every sample-based
    // tonal instrument routed through this class — keys, leadSynths,
    // synths, popBrass, popStrings, orchestral, vocals — got its samples
    // truncated dead at the scheduled note-off boundary, even though the
    // samples themselves carry natural decay. Extending the MIDI note's
    // duration by a fixed tail past the nominal noteEnd lets the TE
    // sampler continue playing the underlying sample for that many
    // additional beats, recovering the perceptual let-ring without
    // reverting the sampler choice. See docs/58a-sound-parity-audit.md
    // for the three-option proposal and why this (option b) is preferred
    // over re-enabling USE_CASPERAKI_SAMPLER (option a) at this stage.
    //
    // Bass.h and Guitar.h have their own createSegmentClip overrides and
    // are not affected. addNoteToClip's same-pitch overlap shortener
    // (SequencerUtils.h:647-655) still trims a previous note whose tail
    // would otherwise step on the next noteOn at the same pitch, so the
    // extension is naturally bounded by the next event on each voice.
    static constexpr double SUSTAIN_TAIL_BEATS = 2.0;

    void createSegmentClip (const j::String& segName,
        const te::TimeRange& segTimeRange,
        const te::TimeRange& loopTimeRange,
        const j::Array<TimeNote>& timeNotes,
        const j::Array<TimeStrums> &timeStrums,
        const j::var& mute) override
    {

        auto clip = track->insertNewClip(te::TrackItem::Type::midi, segName,
            segTimeRange, nullptr);
        auto notesMidiClip = dynamic_cast<te::MidiClip*>(clip);
        jassert(notesMidiClip != nullptr);
        // loop range is the part that loops, i.e., the length of the instrument
        // pattern
        notesMidiClip->setLoopRange(loopTimeRange);

        for (const auto& timeNote : timeNotes)
        {
            TimeNote sustained = timeNote;
            sustained.duration += SUSTAIN_TAIL_BEATS;
            addNoteToClip (notesMidiClip, sustained, VelocityMode::beat);
        }

        applyMuteToTrack (track, segTimeRange, mute);
    }

    void initTracks() override
    {
        int currNumTracks = te::getAudioTracks(edit).size();
        edit.ensureNumberOfAudioTracks(currNumTracks + 1);

        track = te::getAudioTracks(edit)[currNumTracks];
        track->setName(name);

        jassert(track != nullptr);

        track->pluginList.insertPlugin(notesSamplerPlugin, 0, nullptr);
    }

private:
    void initPlugins()
    {
        auto samples = sampleData.getArray();
        for (auto sample : *samples)
        {
            j::DynamicObject::Ptr sampleObj = sample.getDynamicObject();
            ids.get()->setProperty(sampleObj->getProperty("note").toString(),
                (int)sampleObj->getProperty("id"));
        }

        juce::String sampleLoadPath = generateSampleLoadPath(baseURL);

        SampleDownloader sampleDownloader;
        FileMapPtr files = sampleDownloader.downloadSamples(
            edit, sampleLoadPath,
            "vstsample", ids);

        // init sampler
        notesSamplerPlugin = edit.getPluginCache().createNewPlugin(
            SamplerPlugin::xmlTypeName, {});

        createSampler(files);
    }

    void playNote(std::string noteDataStr) override
    {
        if (notesSamplerPlugin.get() == nullptr)
        {
            DBG("Notes Sampler Plugin has not been created");
            return;
        }

        // We obtain a pointer to the SamplerPlugin object
        auto samplerPlugin = dynamic_cast<SamplerPlugin*> (notesSamplerPlugin.get());

        juce::var parsedNoteData = juce::JSON::parse(juce::String(noteDataStr));

        Chord c{"C"};
        auto timeNotes = getRealNotes(parsedNoteData, c, c);

        juce::BigInteger keysHeldDown;
        samplerPlugin->playNotes(keysHeldDown); // We let go of all of the keys

        for (auto note : timeNotes)
        {
            keysHeldDown.setBit (note.note.midiNote);
        }

        samplerPlugin->playNotes(keysHeldDown); // And then we play the new note
    }

    void createSampler(FileMapPtr files)
    {
        DBG("SAMPLES DOWNLOADED!!! for " << name);

        // transform unordered notes into ordered (midi) notes
        std::map<int, j::String> midiNoteFiles{};
        for (auto it = files.get()->begin(); it != files.get()->end(); it++)
        {
            juce::String fullPathName = juce::File::getCurrentWorkingDirectory().getChildFile(it->second).getFullPathName();

            midiNoteFiles.insert(std::pair<int, j::String>{getMidiNoteNumber(it->first), fullPathName});
            DBG("Added note: " << getMidiNoteNumber(it->first));
        }

        int zoneStart = 0, zoneEnd = 0;

        SamplerPlugin* samplerPlugin = dynamic_cast<SamplerPlugin*> (notesSamplerPlugin.get());
        jassert(samplerPlugin != nullptr);

        for (auto it = midiNoteFiles.begin(); it != midiNoteFiles.end(); it++)
        {
            //            DBG( "sorted note: " << it->first << " -> " << it->second );

            juce::String fullPathName = it->second;
            DBG(fullPathName);
            jassert(juce::File(fullPathName).existsAsFile());

            const auto error = samplerPlugin->addSound(
                makeRelative(fullPathName), getMidiNoteName(it->first), 0.0, 0.0, 0.0f);
            jassert(error.isEmpty());

            auto next = std::next(it, 1);
            if (next == midiNoteFiles.end())
            {
                zoneEnd = 180;
            }
            else
            {
                zoneEnd = it->first + (next->first - it->first) / 2;
            }

            samplerPlugin->setSoundParams(samplerPlugin->getNumSounds() - 1,
                it->first, zoneStart, zoneEnd);
            //            DBG( "Added sample note: " << it->first << " -> " <<
            //            zoneStart << "-" << zoneEnd );
            zoneStart = zoneEnd + 1;
        }

        ready = true;
    }

    juce::DynamicObject::Ptr ids{ new juce::DynamicObject() };

    te::AudioTrack* track = nullptr;

    SamplerPlugin::Ptr notesSamplerPlugin;

    j::var sampleData;
};