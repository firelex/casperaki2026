//
// Created by Tiago Alves on 22/06/2022.
//

#pragma once

#include "Instrument.h"
#include "SamplesDownloadTask.h"

class Loop: public Instrument
{
public:
    Loop (te::Edit &edit, const j::var &instrumentData, juce::String baseURL) : Instrument (edit, instrumentData, baseURL)
    {
        auto detailsData = instrumentData["details"];

        if (detailsData.hasProperty ("bpm"))         bpm = std::stoi( detailsData["bpm"].toString().toStdString() );
//        else jassertfalse;

        if (detailsData.hasProperty ("duration"))    duration = detailsData["duration"];
//        else jassertfalse;

//        if (detailsData.hasProperty ("original"))    original = detailsData["original"].toString();
//        else jassertfalse;

        initSampleFile();
    }

    virtual ~Loop()
    {
        sampleId.reset();
        DBG("Loop DESTROYED!!!");
    }

    j::Array<te::AudioTrack*> getAudioTracks() override
    {
        return j::Array<te::AudioTrack*>{track};
    }
    
    void processSegment (j::var songData, Instrument *inst, j::String segmentName, te::TimeRange segmentTimeRange, j::Array<j::var> *segmentBars) override
    {
        const j::var mute = getInstrumentMute (songData, inst, segmentName);
        auto loopInstrument = dynamic_cast<Loop *> (inst);
        if (loopInstrument == nullptr)
        {
            DBG("Instrument " << inst->id << " is not Loop!");
            return;
        }
        loopInstrument->createSegmentClip (segmentName, segmentTimeRange, mute);
    }

    void createSegmentClip (const j::String& segName, const te::TimeRange& segTimeRange, const j::var& mute)
    {
        jassert (sampleFile.existsAsFile());

        // docs/54o: drop setLoopRangeBeats (hangs renderToFile) + setLoopInfo
        // (library is pre-stretched). Tile with N = ceil(seg/source).
        auto waveClip = track->insertWaveClip (segName, sampleFile, te::ClipPosition {segTimeRange}, true);
        const double sourceSec  = waveClip->getSourceLength ().inSeconds ();
        const double segmentSec = segTimeRange.getLength ().inSeconds ();
        const int    nLoops     = sourceSec > 0
            ? std::max (1, (int) std::ceil (segmentSec / sourceSec))
            : 1;
        waveClip->setNumberOfLoops (nLoops);
        waveClip->setLength (segTimeRange.getLength (), false);

        applyMuteToTrack (track, segTimeRange, mute);
    }

    int getPatternBarsCount (j::var) override
    {
        jassert (sampleFile.existsAsFile());
        
        auto audioFile = te::AudioFile (edit.engine, sampleFile);
        double audioFileLength = audioFile.getLength();
        te::tempo::BarsAndBeats b = edit.tempoSequence.toBarsAndBeats (te::TimePosition::fromSeconds (audioFileLength    ));
        
        return b.bars;
    }

    void initTracks() override
    {
        int currNumTracks = te::getAudioTracks(edit).size();
        edit.ensureNumberOfAudioTracks (currNumTracks + 1);

        track = te::getAudioTracks (edit)[currNumTracks];
        track->setName (name);
    }

private:

    void initSampleFile()
    {
        sampleId.get()->setProperty (j::String (id), id);
        
        juce::String samplePlayPath = generateSamplePlayPath (baseURL);

        SampleDownloader sampleDownloader;
        FileMapPtr files = sampleDownloader.downloadSamples (
            edit,
            samplePlayPath,
            j::String("playsample"),
            sampleId
        );
        
        if (files.get()->empty())
        {
            DBG("Loop " << id << " has no downloaded sample files; skipping load.");
            return;
        }

        juce::String fullPathName = files.get()->begin()->second;

        sampleFile = j::File::getCurrentWorkingDirectory().getChildFile(fullPathName);

        DBG(sampleFile.getFullPathName());
        jassert(sampleFile.existsAsFile());
    }

    juce::DynamicObject::Ptr sampleId {new juce::DynamicObject()};
    
    int bpm = 0;
    double duration = 0;
    j::String original;

    j::File sampleFile;

    te::AudioTrack *track = nullptr;
};

