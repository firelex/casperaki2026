//
// Created by Tiago Alves on 16/06/2022.
//

#pragma once

#include <JuceHeader.h>

#include "../instruments/Instrument.h"
#include "../music/Chord.h"
#include <future>
#include "../RestRequest.h"

typedef std::function<void()> Callback;



class Sequencer
{
public:

    Sequencer (te::Engine &_engine, te::Edit &_edit, j::OwnedArray<Instrument> &_instruments, juce::String genre = "ballad");

    ~Sequencer();

    void setSong (j::var &songData);
    void setSongAsync (j::var &songData, Callback finishedCallback);
    
    void addSubmixTrackPlugins (j::String genre);
    void addMasterTrackPlugins (j::String genre);
    void addSendTrackPlugins (j::String genre);
    
    std::string extractRackXMLFromTrackPreset (const std::string& xml)
    {
        // Find the start and end positions of the <RACK> element
        size_t startPos = xml.find("<RACK");
        size_t endPos = xml.find("</RACK>", startPos);

        // Extract the <RACK> element
        std::string rackXml = xml.substr(startPos, endPos - startPos + 7);

        // Return the extracted <RACK> element
        return rackXml;
    }
    
    void setAuxSend (te::Plugin* auxSendPlugin, float busIndex, float gainInDb)
    {
        auto auxSend = dynamic_cast<te::AuxSendPlugin*> (auxSendPlugin);
        auxSend->busNumber.setValue (busIndex, nullptr);
        auxSend->setGainDb (gainInDb);
    }
    
    void setAuxReturn (te::Plugin* auxReturnPlugin, float busIndex)
    {
        auto auxReturn = dynamic_cast<te::AuxReturnPlugin*> (auxReturnPlugin);
        auxReturn->busNumber.setValue (busIndex, nullptr);
    }
  
    void initializeSubmixTrack (FX::InstrumentGroup instrumentGroup, const juce::String& trackName);
    void initializeSendTrack (FX::Send FXSend, juce::String FXSendName);
    void prepareInstrumentTracksWithPlugins (Instrument* instrument, te::FolderTrack::Ptr submixTrack, juce::String genre);
    void prepareTrackWithPlugins (te::AudioTrack* track, te::FolderTrack::Ptr destinationSubmix, FX::FXSendParameters fxSendParameters);
    void insertSendPlugin (te::AudioTrack* track, int position, int auxNumber, float gainInDb);

private:
    te::Engine &engine;
    te::Edit &edit;

    te::AudioTrack *masterTrack = nullptr;
    te::AudioTrack *sampleTransitionsTrackFX = nullptr;
    te::AudioTrack *sampleTransitionsTrackPercussion = nullptr;

    j::HashMap<FX::InstrumentGroup, te::FolderTrack::Ptr> submixTracks;
    j::HashMap<FX::Send, te::AudioTrack::Ptr> sendTracks;
    
    j::OwnedArray<Instrument> &instruments;
    
    j::Array<j::var> * defaultSegmentBars = nullptr;
    j::Array<j::var> * getDefaultSegmentBars (j::var &songData);
};
