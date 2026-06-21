//
// Created by Tiago Alves on 05/05/2022.
//

#pragma once

#include <JuceHeader.h>
#include "../FX.h"
#include "SequencerUtils.h"
#include "../CasperakiSamplerPlugin.h"

class Instrument
{
public:
    enum Type
    {
        drums,
        basses,
        leadSynths,
        synths,
        keys,
        popBrass,
        popStrings,
        acousticGuitars,
        electricGuitars,
        loop,
        transitionNoise,
        transitionSample,
        transitionPattern,
        orchestral,
        vocals
    };
    
    // constructor
    Instrument (te::Edit &, j::var instrumentData, juce::String newBaseURL);
    
    
    juce::String baseURL;
    
    void clearTracks ()
    {
        for (auto track: getAudioTracks())
        {
            if (track != nullptr)
            {
                try
                {
                    clearTrack(track);
                }
                catch (std::exception e)
                {
                    DBG("Error clearing track");
                }
            }
        }
    };

    juce::String generatePath (const juce::String& baseURL, const juce::String& suffixPath)
    {
        juce::String fullPath = baseURL;
        fullPath += "/" + suffixPath;

        return fullPath;
    }


    juce::String generateSampleLoadPath (const juce::String& baseURL)
    {
        juce::String sampleLoadPath;
        sampleLoadPath = baseURL + "/vstSample/load/";
        return sampleLoadPath;
    }

    juce::String generateSamplePlayPath (const juce::String& baseURL)
    {
        juce::String samplePlayPath;
        samplePlayPath = baseURL + "/playSample/";
        return samplePlayPath;
    }
    
    juce::String makeRelative (juce::String absoluteFilePath)
    {
        juce::File sampleFile = juce::File (absoluteFilePath);
        juce::String relativePathName = "./" + sampleFile.getRelativePathFrom (edit.editFileRetriever());
        return relativePathName;
    }
    
    virtual ~Instrument ()
    {
        DBG("Instrument destroyed!!!!");
    }
    
    virtual void initTracks () = 0;
    
    virtual int getPatternBarsCount (j::var patternData) = 0;
    
    virtual j::Array<te::AudioTrack *> getAudioTracks () = 0;
    
    bool isTransition ();
    
    void applySignalProcessor (const te::TimeRange &segmentTimeRange, const j::var &signalProcessorData);
    
    // attributes
    int id;
    Type type;
    FX::InstrumentGroup fxGroup;
    j::String lowLevelType;
    j::String name;
    double defaultVolume = 0.0;
    
    bool ready = false;
    
    static Type getType (j::String);
    
    static int getInstrumentId (const j::var &instrumentData);
    
    virtual void playNote (std::string noteDataStr) {};
    
    te::Edit &edit;

    j::var getInstrumentArrangementData (juce::var &songData, Instrument *instrument, j::String segmentName, j::String dataName, j::var defaultValue = false)
    {
        j::var arrangementData;
        // arrangement: {}
        if (!songData.hasProperty ("arrangement"))
            return defaultValue;
        arrangementData = songData.getProperty ("arrangement", defaultValue);
        
        // arrangement: {<segmentName>: {}}
        if (!arrangementData.hasProperty (segmentName))
            return defaultValue;
        arrangementData = arrangementData.getProperty (segmentName, j::var{});
        
        // arrangement: {<segmentName>: {overrides: {} }}
        if (!arrangementData.hasProperty (dataName))
            return defaultValue;
        arrangementData = arrangementData.getProperty (dataName, j::var{});
        
        // arrangement: {<segmentName>: { overrides: {<instrumentName>: {}}}}
        if (!arrangementData.hasProperty (instrument->name))
            return defaultValue;
        
        arrangementData = arrangementData.getProperty (instrument->name, j::var{});
        
        return arrangementData;
    }
    
    virtual void initClips ()
    {
    }
    
    bool isInstrumentInSegment (juce::var &songData, Instrument *instrument, j::String segmentName)
    {
        return (bool) getInstrumentArrangementData (songData, instrument, segmentName, "instruments", true);
    }
    
    juce::var getInstrumentOverride (juce::var &songData, Instrument *instrument, j::String segmentName)
    {
        return getInstrumentArrangementData (songData, instrument, segmentName, "overrides");
    }
    
    juce::var getInstrumentFill (juce::var &songData, Instrument *instrument, j::String segmentName)
    {
        return getInstrumentArrangementData (songData, instrument, segmentName, "fills");
    }
    
    juce::var getInstrumentMute (juce::var &songData, Instrument *instrument, j::String segmentName)
    {
        return getInstrumentArrangementData (songData, instrument, segmentName, "mutes");
    }
    
    virtual void
    processSegment (j::var songData, Instrument *inst, j::String segmentName, te::TimeRange segmentTimeRange, j::Array<j::var> *segmentBars)
    {
    }
    
    virtual void processSegment (j::var songData, Instrument *inst, j::String segmentName, te::TimeRange segmentTimeRange, juce::var transitionData)
    {
    }
    
    
    std::vector<te::Plugin::Ptr>& getPostFXList()
    {
        return postFXList;
    }
    
private:
    
    std::vector<te::Plugin::Ptr> postFXList;
    
};
