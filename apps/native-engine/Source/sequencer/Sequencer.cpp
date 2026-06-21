//
// Created by Tiago Alves on 16/06/2022.
//

#include "Sequencer.h"

#include "../common.h"

#include "../instruments/TonalInstrument.h"
#include "../instruments/Drums.h"
#include "../instruments/Loop.h"
#include "../instruments/TransitionSample.h"
#include "../instruments/TransitionNoise.h"
#include "../instruments/TransitionPattern.h"
#include <chrono>

/* song utils */
j::var
getInstrumentArrangementData (juce::var &songData, Instrument *instrument, j::String segmentName, j::String dataName, j::var defaultValue = false)
{
    j::var arrangementData;
    // arrangement: {}
    if (!songData.hasProperty("arrangement"))
        return defaultValue;
    arrangementData = songData.getProperty("arrangement", defaultValue);

    // arrangement: {<segmentName>: {}}
    if (!arrangementData.hasProperty(segmentName))
        return defaultValue;
    arrangementData = arrangementData.getProperty(segmentName, j::var{});

    // arrangement: {<segmentName>: {overrides: {} }}
    if (!arrangementData.hasProperty(dataName))
        return defaultValue;
    arrangementData = arrangementData.getProperty(dataName, j::var{});

    // arrangement: {<segmentName>: { overrides: {<instrumentName>: {}}}}
    if (!arrangementData.hasProperty(instrument->name))
        return defaultValue;
    arrangementData = arrangementData.getProperty(instrument->name, j::var{});

    return arrangementData;
}

bool isInstrumentInSegment (juce::var &songData, Instrument *instrument, j::String segmentName)
{
    return (bool) getInstrumentArrangementData(songData, instrument, segmentName, "instruments", true);
}

// check if there is a transition in the current segment for an instrument
juce::var getTransitionSegmentData (juce::var &songData, Instrument *instrument, j::String segmentName)
{
    if (!(instrument->isTransition()))
    {
        return false;
    }

    j::var arrangementData;
    if (!songData.hasProperty("arrangement"))
        return false;
    arrangementData = songData.getProperty("arrangement", j::var{});

    if (!arrangementData.hasProperty(segmentName))
        return false;
    arrangementData = arrangementData.getProperty(segmentName, j::var{});

    // arrangement: {<segmentName>: {overrides: {} }}
    if (!arrangementData.hasProperty("transitions"))
        return false;
    arrangementData = arrangementData.getProperty("transitions", j::var{});

    for (auto prop : arrangementData.getDynamicObject()->getProperties())
    {
        auto transitionObject = prop.value.getDynamicObject();
        if (transitionObject == nullptr)
            continue;

        int id;

        if (transitionObject->hasProperty ("id") && transitionObject->getProperty ("id").isInt ())
            id = (int)transitionObject->getProperty ("id");
        else if (transitionObject->hasProperty ("id") && transitionObject->getProperty ("id").isString () && transitionObject->getProperty ("id").toString () == "fxNoiseRise")
            id = 104; // for transitionNoise
        else if (transitionObject->hasProperty ("transitionId") && transitionObject->getProperty ("transitionId").isInt ())
            id = 100000 + (int)transitionObject->getProperty ("transitionId"); // for transitionPattern
        else
            jassert(false);

        if (id == instrument->id)
        {
            return transitionObject;
        }
    }

    return false;
}

juce::var getInstrumentOverride (juce::var &songData, Instrument *instrument, j::String segmentName)
{
    return getInstrumentArrangementData(songData, instrument, segmentName, "overrides");
}

juce::var getInstrumentFill (juce::var &songData, Instrument *instrument, j::String segmentName)
{
    return getInstrumentArrangementData(songData, instrument, segmentName, "fills");
}

juce::var getInstrumentMute (juce::var &songData, Instrument *instrument, j::String segmentName)
{
    return getInstrumentArrangementData(songData, instrument, segmentName, "mutes");
}

Sequencer::Sequencer (te::Engine &_engine, te::Edit &_edit, j::OwnedArray<Instrument> &_instruments, juce::String genre)
    : engine(_engine), edit(_edit), instruments(_instruments)
{
    // reset audio tracks
    for (auto track: te::getAllTracks(edit))
    {
        if (track->isFolderTrack() || track->isAudioTrack())
            edit.deleteTrack (track);
    }

    // create master track
    edit.ensureNumberOfAudioTracks (3);
    masterTrack = te::getAudioTracks (edit)[0];
    sampleTransitionsTrackFX = te::getAudioTracks (edit)[1];
    sampleTransitionsTrackPercussion = te::getAudioTracks (edit)[2];

    if (masterTrack != nullptr)
    {
        masterTrack->setName ("MASTER");
    }

    if (sampleTransitionsTrackFX != nullptr)
    {
        sampleTransitionsTrackFX->setName ("Sample Transitions FX");
    }
    
    if (sampleTransitionsTrackPercussion != nullptr)
    {
        sampleTransitionsTrackPercussion->setName ("Sample Transitions FX");
    }
    
    initializeSubmixTrack (FX::kicks, "kick");
    initializeSubmixTrack (FX::snares, "snare");
    initializeSubmixTrack (FX::toms, "tom");

    for (auto instrument: instruments)
    {
        instrument->initTracks();
        FX::InstrumentGroup instrumentGroup = instrument->fxGroup;

        if (!submixTracks.contains (instrumentGroup))
        {
            initializeSubmixTrack (instrumentGroup, FX::instrumentGroupToString (instrumentGroup));
        }

        te::FolderTrack::Ptr submixTrack = submixTracks[instrumentGroup];

        try
        {
            prepareInstrumentTracksWithPlugins (instrument, submixTrack, genre);
        }
        catch (...)
        {
            std::cerr << "Preparing Instrument Track: " << instrument->name << " failed" << std::endl;
        }
    }
    
    for (auto instrument : instruments)
    {
        for (auto track : instrument->getAudioTracks())
        {
            if (track->getName () == "edmSnareDrumRoll")
            {
                track->getVolumePlugin()->setVolumeDb (-12.0f);
            }
        }
        if (instrument->type == Instrument::Type::transitionSample)
        {
            // docs/54o: the `fx` submix track is only lazily created when an
            // instrument's fxGroup == fx (line 153-156). cymbalsCrashHit etc
            // belong to fxGroup `drums`, so when the first transitionSample is
            // processed `submixTracks[fx]` is a default-constructed null
            // FolderTrack::Ptr and `.get()` returns nullptr. The subsequent
            // `submixTracks[fx]->getOutput()` then trips
            // `juce_ReferenceCountedObject.h:394` (null operator->). Eagerly
            // create the fx submix on first transitionSample to fix.
            if (!submixTracks.contains (FX::InstrumentGroup::fx))
            {
                initializeSubmixTrack (FX::InstrumentGroup::fx, FX::instrumentGroupToString (FX::InstrumentGroup::fx));
            }
            edit.moveTrack (te::Track::Ptr {*sampleTransitionsTrackFX}, te::TrackInsertPoint {submixTracks[FX::InstrumentGroup::fx].get(), nullptr});
            auto output = submixTracks[FX::InstrumentGroup::fx]->getOutput();
            output->setOutputToTrack (masterTrack);
            try
            {
                prepareInstrumentTracksWithPlugins (instrument, submixTracks[FX::InstrumentGroup::fx], genre);
            }
            catch (...)
            {
                std::cerr << "Preparing Sample Transitions Track = failed" << std::endl;
            }
            continue; 
        }
    }
    
    // docs/65 — Sample Transitions FX/percussion trim (-10 dB) and master trim
    // (-1 dB) from the shared mix-config when loaded, else the hardcoded values.
    const auto& mixCfg = casperaki::mix::MixConfig::instance();
    const float transitionsTrimDb = mixCfg.loaded() ? (float) mixCfg.transitionsTrimDb() : -10.0f;
    const float masterTrimDb      = mixCfg.loaded() ? (float) mixCfg.masterVolumeDb()    : -1.0f;
    sampleTransitionsTrackFX->getVolumePlugin()->setVolumeDb (transitionsTrimDb);
    sampleTransitionsTrackPercussion->getVolumePlugin()->setVolumeDb (transitionsTrimDb);
    edit.getMasterVolumePlugin()->setVolumeDb (masterTrimDb);
    
    for (const auto& pair : FX::fxSendTable)
    {
        const juce::String& FXSendName = pair.first;
        FX::Send FXSend = pair.second;
        initializeSendTrack (FXSend, FXSendName);
    }
}

void Sequencer::initializeSubmixTrack(FX::InstrumentGroup instrumentGroup, const juce::String& trackName)
{
    te::TrackInsertPoint insertPoint{nullptr, masterTrack};
    te::FolderTrack::Ptr newSubmixTrack = edit.insertNewFolderTrack(insertPoint, nullptr, true);
    newSubmixTrack->setName(trackName);

    float hue = ((newSubmixTrack->getFolderTrackNumber() - 1) % 9) / 9.0f;
    newSubmixTrack->setColour(j::Colours::red.withHue(hue));
    
    submixTracks.set(instrumentGroup, newSubmixTrack);
}

void Sequencer::initializeSendTrack (FX::Send FXSend, juce::String FXSendName)
{
    te::TrackInsertPoint insertPoint{nullptr, masterTrack};
    te::AudioTrack::Ptr newSendTrack = edit.insertNewAudioTrack(insertPoint, nullptr);
    newSendTrack->setName (FXSendName);
    sendTracks.set (FXSend, newSendTrack);
}

void Sequencer::prepareInstrumentTracksWithPlugins(Instrument* instrument, te::FolderTrack::Ptr submixTrack, juce::String genre = "ballad")
{
    auto drumSubmixTrack = submixTracks[FX::drums];
    auto kickSubmixTrack = submixTracks[FX::kicks];
    auto snareSubmixTrack = submixTracks[FX::snares];
    auto tomSubmixTrack = submixTracks[FX::toms];

    juce::String FXGroup = FX::instrumentGroupToString(FX::getFXGroupFromLowLevelType(instrument->lowLevelType));
    FX::FXSendParameters fxParams = FX::instrumentFxSettings.at(FXGroup);

    // docs/65 — when the shared mix-config is loaded, the per-lane aux-send levels
    // come from FX::getLaneSends (the JSON laneSendOverrides). The submix-routing
    // decisions below (kick/drum submix vs the group submix) are engine plumbing
    // and stay hardcoded. The original per-lowLevelType/genre send chain remains
    // as the fallback used when the config is not loaded.
    const auto& mixCfg = casperaki::mix::MixConfig::instance();

    auto lowLevelType = instrument->lowLevelType;
    for (auto track : instrument->getAudioTracks())
    {
        //If this is the kick track
        if (lowLevelType == "drums")
        {
            if (static_cast<Drums*>(instrument)->kicksTrack == track)
            {
                auto kickFXParams = mixCfg.loaded() ? FX::getInstrumentFxSends ("kicks")
                                                    : FX::instrumentFxSettings.at ("kicks");
                prepareTrackWithPlugins (track, kickSubmixTrack, kickFXParams);
            }
            //else if (static_cast<Drums*>(instrument)->snaresTrack == track)
            //{
            //    auto snareFXParams = FX::instrumentFxSettings.at ("snares");
            //    prepareTrackWithPlugins (track, snareSubmixTrack, snareFXParams);
            //}
            //else if (static_cast<Drums*>(instrument)->tomsTrack == track)
            //{
            //    auto tomFXParams = FX::instrumentFxSettings.at ("toms");
            //    prepareTrackWithPlugins (track, tomSubmixTrack, tomFXParams);
            //}
            else
            {
                auto drumParams = mixCfg.loaded() ? FX::getLaneSends ("drums", lowLevelType, genre) : fxParams;
                prepareTrackWithPlugins (track, (instrument->lowLevelType == "drums") ? drumSubmixTrack : submixTrack, drumParams);
            }
        }
        else if (mixCfg.loaded())
        {
            // Config path: a single laneSends lookup replaces the per-type/genre
            // send chain below; route to the instrument's group submix track.
            prepareTrackWithPlugins (track, submixTrack, FX::getLaneSends (FXGroup, lowLevelType, genre));
        }
        else if (lowLevelType == "acousticGuitarsNylonMono" ||
                 lowLevelType == "acousticGuitarsNylonStereo" ||
                 lowLevelType == "acousticGuitarsSteelMono" ||
                 lowLevelType == "acousticGuitarsSteelStereo")
        {
            auto synthFXParams = FX::FXSendParameters{ fxParams.reverbGainInDb - 8.0f, fxParams.delayGainInDb - 8.0f, fxParams.chorusGainInDb - 8.0f };
            prepareTrackWithPlugins(track, submixTrack, synthFXParams);
        }
        //else if (lowLevelType == "leadSynthsAnalog" ||
        //    lowLevelType == "leadSynthsBright" ||
        //    lowLevelType == "leadSynthsDistorted" ||
        //    lowLevelType == "leadSynthsSoft")
        //{
        //    auto synthFXParams = FX::FXSendParameters{ fxParams.reverbGainInDb, -10.0f, fxParams.chorusGainInDb };
        //    prepareTrackWithPlugins(track, submixTrack, synthFXParams);
        //}
        else if (lowLevelType == "synthsBrightPad" ||
            lowLevelType == "synthsSoftPad")
        {
            auto synthFXParams = FX::FXSendParameters{ -14.0f, fxParams.delayGainInDb, fxParams.chorusGainInDb };
            prepareTrackWithPlugins(track, submixTrack, synthFXParams);
        }
        else if (lowLevelType == "synthsPlucked")
        {
            auto synthFXParams = FX::FXSendParameters{ fxParams.reverbGainInDb, -10.0f, fxParams.chorusGainInDb };
            prepareTrackWithPlugins (track, submixTrack, synthFXParams);
        }
        else if (lowLevelType == "keysAcousticPiano")
        {
            auto synthFXParams = FX::FXSendParameters{ -14.0f, -10.0f, fxParams.chorusGainInDb };
            prepareTrackWithPlugins(track, submixTrack, synthFXParams);
        }
        else if (genre == "ballad")
        {
            if (lowLevelType == "snareDrumsAcoustic" ||
                lowLevelType == "snareDrumsElectronic")
            {
                auto synthFXParams = FX::FXSendParameters { -14.0f, fxParams.delayGainInDb, fxParams.chorusGainInDb };
                prepareTrackWithPlugins (track, submixTrack, synthFXParams);
            }
            else if (lowLevelType == "drums")
            {
                auto drumFXParams = FX::FXSendParameters{ -14.0f, fxParams.delayGainInDb, fxParams.chorusGainInDb };
                prepareTrackWithPlugins (track, submixTrack, drumFXParams);
            }
            else
                prepareTrackWithPlugins (track, submixTrack, fxParams);
        }
        else if (genre == "rock")
        {
            if (lowLevelType == "drums" )
            {
                auto drumFXParams = FX::FXSendParameters{ -18.0f, fxParams.delayGainInDb, fxParams.chorusGainInDb };
                prepareTrackWithPlugins (track, submixTrack, drumFXParams);
            }
            else
                prepareTrackWithPlugins (track, submixTrack, fxParams);
        }
        else
            prepareTrackWithPlugins (track, (instrument->lowLevelType == "drums") ? drumSubmixTrack : submixTrack, fxParams);
    }
}


void Sequencer::prepareTrackWithPlugins (te::AudioTrack* track, te::FolderTrack::Ptr destinationSubmix, FX::FXSendParameters fxSendParameters)
{
    edit.moveTrack (te::Track::Ptr{*track}, te::TrackInsertPoint{destinationSubmix.get(), nullptr});
    auto output = destinationSubmix->getOutput();
    output->setOutputToTrack (masterTrack);

    insertSendPlugin (track, 11, 0, fxSendParameters.reverbGainInDb);
    insertSendPlugin (track, 12, 1, fxSendParameters.delayGainInDb);
    insertSendPlugin (track, 13, 2, fxSendParameters.chorusGainInDb);
}

void Sequencer::insertSendPlugin (te::AudioTrack* track, int position, int auxNumber, float gainInDb)
{
    auto sendPlugin = edit.getPluginCache().createNewPlugin (te::AuxSendPlugin::xmlTypeName, {}).get();
    track->pluginList.insertPlugin (sendPlugin, position, nullptr);
    setAuxSend (sendPlugin, auxNumber, gainInDb);
}

Sequencer::~Sequencer ()
{
    if (defaultSegmentBars)
        delete (defaultSegmentBars);
}


void Sequencer::setSongAsync (j::var &songData, Callback finishedCallback)
{
    // ToDo

    if (finishedCallback)
        finishedCallback();
}

void Sequencer::setSong (j::var& songData)
{
    te::ArrangerTrack* arrangerTrack = edit.getArrangerTrack();
    te::ChordTrack* chordTrack = edit.getChordTrack();

    DBG (juce::String (juce::JSON::toString (songData)));

    juce::Logger::writeToLog ("Setting song in Sequencer \n");

    // clear clips
    clearTrack(arrangerTrack);
    clearTrack(chordTrack);

    edit.tempoSequence.insertTempo(te::BeatPosition::fromBeats(0), songData["tempo"], 0);

    auto tempo = songData["tempo"];
    juce::Array<juce::var>* structure = songData["structure"].getArray();
    auto genre = juce::JSON::toString (songData["genre"]);

    if (structure == NULL) return;

    jassert (structure->size() > 0);
    
    DBG ("Structure has " + juce::String (structure->size()) + " elements.");
    
    
    juce::String firstString = juce::JSON::toString ((*structure)[0]);
    
    DBG (firstString);

    //    double segStartTime = 0.0;
    te::BeatPosition segStartBeat = te::BeatPosition::fromBeats(0);
    te::BeatPosition nextSegStartBeat = te::BeatPosition::fromBeats(0);

    // for each segment in structure
    int segmentIndex = 0;
    for (auto segmentData : *structure)
    {   
        juce::var nextSegmentData;

        j::String segmentName = segmentData["segment"];
        if (segmentName.isQuotedString()) segmentName = segmentName.unquoted();

        j::Array<j::var>* segmentBars;
        
        if ((songData["isVibe"].isBool() && (bool)songData["isVibe"]))
        {
            segmentBars = getDefaultSegmentBars(songData);
        }
        else
        {
            segmentBars = segmentData["bars"].getArray();
        }

        //        const te::EditTimeRange segmentTimeRange = te::EditTimeRange::withStartAndLength(segStartTime, edit.tempoSequence.barsBeatsToTime({segmentBars->size(), 0.0}));

        if (segmentBars == nullptr)
        {
            DBG (segmentData.toString());
            std::cerr << "Segment Bars is actually NULL." << std::endl;
        }
        
        
        te::tempo::BarsAndBeats segBarsAndBeats = te::tempo::BarsAndBeats {segmentBars->size(), te::BeatDuration::fromBeats (0.0)};

        const te::BeatRange segmentBeatRange{
            segStartBeat,
                te::BeatDuration::fromBeats(edit.tempoSequence.toBeats (segBarsAndBeats).inBeats())};

        te::TimeRange segmentTimeRange = edit.tempoSequence.toTime (segmentBeatRange);

        // add arranger clip
        te::Clip *clip = arrangerTrack->insertNewClip (te::TrackItem::Type::arranger, segmentName, segmentTimeRange, nullptr);
        auto arrangerClip = dynamic_cast<te::ArrangerClip *> (clip);
        jassert(arrangerClip != nullptr);

        // for each instrument
        for (auto inst : instruments)
        {
            // if instrument not present in segment, don't do anything here
            if (!isInstrumentInSegment (songData, inst, segmentName))
                continue;

            if (inst->type == Instrument::Type::transitionSample)
                static_cast<TransitionSample*> (inst)->setSampleTransitionsTrack (sampleTransitionsTrackFX);

            if (inst->type == Instrument::Type::transitionSample ||
                inst->type == Instrument::Type::transitionNoise  ||
                inst->type == Instrument::Type::transitionPattern)
            {
                j::var transitionData = getTransitionSegmentData(songData, inst, segmentName);
                //        processTransitionNoise(songData, inst, segmentName, segmentTimeRange, transitionData);
                try {
                    inst->processSegment(songData, inst, segmentName, segmentTimeRange, transitionData);
                } catch (std::exception& e) {
                    juce::Logger::writeToLog ("Error processing segment for " + inst->name + " in " + segmentName + ": " + e.what());
                }
            }
            else
            {
                try {
                    inst->processSegment(songData, inst, segmentName, segmentTimeRange, segmentBars);
                } catch (std::exception& e) {
                    juce::Logger::writeToLog ("Error processing segment for " + inst->name + " in " + segmentName + ": " + e.what());
                }
            }

            auto signalProcessorData = getInstrumentArrangementData(songData, inst, segmentName, "signalProcessors");
            if (!!signalProcessorData)
            {
                juce::Logger::writeToLog("Found signal processors for " + inst->name + " in " + segmentName);
                inst->applySignalProcessor(segmentTimeRange, signalProcessorData);
            }
        }


        //        segStartTime += segmentTimeRange.getLength().inSeconds();
        segStartBeat = segStartBeat + segmentBeatRange.getLength();


        //Remember to clear j::Array* objects
        segmentBars->clear();


        segmentIndex++;

    } // end each segment in structure


    edit.getTransport().setLoopRange(te::TimeRange {te::TimePosition::fromSeconds(0.0), edit.getLength() });
    edit.getTransport().looping = true;

    
    if (genre.isQuotedString())
    {
        genre = genre.unquoted();
    }


    // for each instrument
    for (auto inst : instruments) 
    {
        if (inst->lowLevelType == "drums") {
            // tracks array: { kicksTrack, snaresTrack, tomsTrack, restTrack }
            auto drumsInstrument = static_cast<Drums*>(inst);
            drumsInstrument->setInstrumentTargetVolumes (genre);
        }
        else
        {
            // apply default instrument volumes
            for (auto track : inst->getAudioTracks())
            {
                applyPreVolumeToTrack (edit, track, static_cast<float>(FX::getInstrumentTargetVolume (inst->lowLevelType, genre)));
                DBG (inst->lowLevelType + ": " + juce::String (FX::getInstrumentTargetVolume (inst->lowLevelType, genre)));
            }
        }
    }


    auto start = std::chrono::high_resolution_clock::now();
    
    addSubmixTrackPlugins (genre);
    addSendTrackPlugins (genre);
    addMasterTrackPlugins (genre);

    // Stop the timer
    auto stop = std::chrono::high_resolution_clock::now();

    // Calculate duration
    auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(stop - start);

    // Print or log the duration
    std::cout << "Time taken to load plugins onto tracks: " << duration.count() << " milliseconds" << std::endl;

    juce::Logger::writeToLog ("Plugins have been added to submix, send and master tracks.");
}

void Sequencer::addMasterTrackPlugins (j::String genre)
{
    juce::Logger::writeToLog ("Adding plugins to the master track.");
    
    jassert (masterTrack != nullptr);
    
    if (masterTrack != nullptr)
    {
        try
        {
            auto presetName = genre + "_master";
            auto masterTrackRackPlugin = FX::createRackPluginFromPreset (presetName, &edit, &engine, masterTrack);
            masterTrack->pluginList.insertPlugin (masterTrackRackPlugin, 0, nullptr);
            juce::Logger::writeToLog ("Inserted plugin into Master Track.");
        }
        catch (const std::exception& e)
        {
            std::cerr << "Exception occurred: " << e.what() << std::endl;
            juce::Logger::writeToLog ("Exception occured. Something is wrong with the master track preset file, or AirWindows plugins.");
        }
    }
}


void Sequencer::addSendTrackPlugins (j::String genre)
{
    juce::Logger::writeToLog ("Adding plugins to the send track.");

    //For each FX track, we'll load up the respective rack trkpreset
    //For this to work, .trkpreset files need to be saved with the names of the groups
    //that they represent.
    
    te::AudioTrack::Ptr sendTrack;
    
    for (const auto& pair : FX::fxSendTable)
    {

        const juce::String& FXSendName = pair.first;
        FX::Send FXSend = pair.second;
        
        juce::Logger::writeToLog ("Iterating through FX Send: " + FXSendName);
        
        sendTrack = sendTracks [FXSend];
        
        if (sendTrack == nullptr)
            continue;

        //If send track is nullptr, it means that it hasn't been added to the edit.
        //Certain genres might not make use of certain subtracks.

        try
        {
            //Insert Aux Return First
            auto auxReturn = edit.getPluginCache().createNewPlugin (te::AuxReturnPlugin::xmlTypeName, {}).get();
            sendTrack->pluginList.insertPlugin (auxReturn, 0, nullptr);
            
            setAuxReturn (auxReturn, FXSend);
            
            //Insert Rack
            auto folderRackPlugin = FX::createRackPluginFromPreset (genre + "_" + FXSendName  , &edit, &engine, sendTrack);
            sendTrack->pluginList.insertPlugin (folderRackPlugin, 1, nullptr);

            if (sendTrack->pluginList.getPluginsOfType<te::DelayPlugin> ().size() == 0) continue;

            auto delayPlugin = sendTrack->pluginList.getPluginsOfType<te::DelayPlugin> ()[0];
            if (delayPlugin)
            {
                tracktion::AutomatableParameter::Ptr delayLength = delayPlugin->getAutomatableParameterByID (te::engine::IDs::length.toString ());

                // Get BPM from the tempo sequence at the current transport position
                double bpm = edit.tempoSequence.getTempoAt (edit.getTransport ().position).getBpm ();

                // Calculate the length of a quarter note in milliseconds
                double quarterNoteLengthMs = 60000.0 / bpm;

                // Calculate the length of an eighth note (half of a quarter note)
                double eighthNoteLengthMs = quarterNoteLengthMs / 2.0;

                // Set the delay length parameter
                delayLength->setParameter (eighthNoteLengthMs, juce::dontSendNotification);

            }
        }
        catch (const std::exception& e)
        {
            std::cerr << "Exception occurred: " << e.what() << std::endl;
        }
    }
}

void Sequencer::addSubmixTrackPlugins (juce::String genre)
{
    juce::Logger::writeToLog ("Adding plugins to submix track.");
    
    //For each FX track, we'll load up the respective rack trkpreset
    //For this to work, .trkpreset files need to be saved with the names of the groups
    //that they represent.
    
    te::FolderTrack::Ptr folderTrack;
    
    for (const auto& pair : FX::fxGroupTable)
    {
        const juce::String& FXGroupName = pair.first;
        FX::InstrumentGroup FXGroup = pair.second;
        
        juce::Logger::writeToLog ("Iterating through FXGroup: " + FXGroupName);
        
        folderTrack = submixTracks [FXGroup];

        //If folderTrack is nullptr, it means that it hasn't been added to the edit.
        //Certain genres might not make use of certain subtracks.
        if (folderTrack != nullptr)
        {
            try
            {
                auto folderRackPlugin = FX::createRackPluginFromPreset (genre + "_" + FXGroupName , &edit, &engine, folderTrack);
                folderTrack->pluginList.insertPlugin (folderRackPlugin, 0, nullptr);
            }
            catch (const std::exception& e)
            {
                std::cerr << "Exception occurred: " << e.what() << std::endl;
            }
        }
    }
}



void addBarObject(juce::Array<juce::var>* defaultSegmentBars, const std::vector<juce::String>& chords)
{
    juce::DynamicObject::Ptr barObject = new juce::DynamicObject();

    juce::Array<juce::var> chordArray;
    for (const auto& chord : chords) {
        chordArray.add(juce::var(chord));
    }

    barObject->setProperty("chords", chordArray);
    defaultSegmentBars->add(juce::var(barObject.get()));
}


//Chords are set here
j::Array<j::var> *Sequencer::getDefaultSegmentBars (j::var &songData)
{
    int numOfBars = 4;
    for (auto instrument: instruments)
    {
        if (instrument->isTransition())
            continue;
        int instNumOfBars = instrument->getPatternBarsCount (getInstrumentPattern (songData, instrument->id));
        juce::Logger::writeToLog ("Num of bars for " + instrument->name + " : " + juce::String (instNumOfBars));
        if (instNumOfBars > numOfBars)
            numOfBars = instNumOfBars;
    }

    Chord::ChordType scaleType = Chord::ChordType::major;
    if (songData.hasProperty("scale") && songData["scale"] == "minor")
        scaleType = Chord::ChordType::minor;

    int iRand = rand() % 10;

    defaultSegmentBars = new j::Array<j::var>{};

    std::vector<juce::String> gChords = {"G", "G", "G", "G"};
    std::vector<juce::String> dChords = {"D", "D", "D", "D"};
    std::vector<juce::String> amChords = {"Am", "Am", "Am", "Am"};
    std::vector<juce::String> cChords = {"C", "C", "C", "C"};
    std::vector<juce::String> emChords = {"Em", "Em", "Em", "Em"};
    std::vector<juce::String> bmChords = {"Bm", "Bm", "Bm", "Bm"};

    if (scaleType == Chord::ChordType::major) {
        switch (iRand) {
            case 0:
                addBarObject (defaultSegmentBars, gChords);
                addBarObject (defaultSegmentBars, dChords);
                addBarObject (defaultSegmentBars, cChords);
                addBarObject (defaultSegmentBars, gChords);
                break;
            case 1:
                addBarObject (defaultSegmentBars, gChords);
                addBarObject (defaultSegmentBars, dChords);
                addBarObject (defaultSegmentBars, emChords);
                addBarObject (defaultSegmentBars, cChords);
                break;
            case 2:
                addBarObject (defaultSegmentBars, gChords);
                addBarObject (defaultSegmentBars, cChords);
                addBarObject (defaultSegmentBars, emChords);
                addBarObject (defaultSegmentBars, dChords);
                break;
            case 3:
                addBarObject (defaultSegmentBars, gChords);
                addBarObject (defaultSegmentBars, dChords);
                addBarObject (defaultSegmentBars, emChords);
                addBarObject (defaultSegmentBars, bmChords);
                break;
            case 4:
                addBarObject (defaultSegmentBars, gChords);
                addBarObject (defaultSegmentBars, dChords);
                addBarObject (defaultSegmentBars, cChords);
                addBarObject (defaultSegmentBars, cChords);
                break;
            case 5:
                addBarObject (defaultSegmentBars, gChords);
                addBarObject (defaultSegmentBars, bmChords);
                addBarObject (defaultSegmentBars, cChords);
                addBarObject (defaultSegmentBars, dChords);
                break;
            case 6:
                addBarObject (defaultSegmentBars, gChords);
                addBarObject (defaultSegmentBars, dChords);
                addBarObject (defaultSegmentBars, emChords);
                addBarObject (defaultSegmentBars, cChords);
                break;
            case 7:
                addBarObject (defaultSegmentBars, gChords);
                addBarObject (defaultSegmentBars, cChords);
                addBarObject (defaultSegmentBars, amChords);
                addBarObject (defaultSegmentBars, dChords);
                break;
            case 8:
                addBarObject (defaultSegmentBars, gChords);
                addBarObject (defaultSegmentBars, cChords);
                addBarObject (defaultSegmentBars, dChords);
                addBarObject (defaultSegmentBars, cChords);
                break;
            case 9:
            default:
                addBarObject (defaultSegmentBars, gChords);
                addBarObject (defaultSegmentBars, cChords);
                addBarObject (defaultSegmentBars, bmChords);
                addBarObject (defaultSegmentBars, emChords);
                break;
        }
    } else {
        switch (iRand) {
            case 0:
                addBarObject (defaultSegmentBars, emChords);
                addBarObject (defaultSegmentBars, amChords);
                addBarObject (defaultSegmentBars, bmChords);
                addBarObject (defaultSegmentBars, amChords);
                break;
            case 1:
                addBarObject (defaultSegmentBars, emChords);
                addBarObject (defaultSegmentBars, cChords);
                addBarObject (defaultSegmentBars, gChords);
                addBarObject (defaultSegmentBars, dChords);
                break;
            case 2:
                addBarObject (defaultSegmentBars, emChords);
                addBarObject (defaultSegmentBars, gChords);
                addBarObject (defaultSegmentBars, cChords);
                addBarObject (defaultSegmentBars, dChords);
                break;
            case 3:
                addBarObject (defaultSegmentBars, emChords);
                addBarObject (defaultSegmentBars, amChords);
                addBarObject (defaultSegmentBars, emChords);
                addBarObject (defaultSegmentBars, amChords);
                break;
            case 4:
                addBarObject (defaultSegmentBars, emChords);
                addBarObject (defaultSegmentBars, dChords);
                addBarObject (defaultSegmentBars, cChords);
                addBarObject (defaultSegmentBars, bmChords);
                break;
            case 5:
                addBarObject (defaultSegmentBars, emChords);
                addBarObject (defaultSegmentBars, amChords);
                addBarObject (defaultSegmentBars, dChords);
                addBarObject (defaultSegmentBars, dChords);
                break;
            case 6:
                addBarObject (defaultSegmentBars, emChords);
                addBarObject (defaultSegmentBars, amChords);
                addBarObject (defaultSegmentBars, gChords);
                addBarObject (defaultSegmentBars, cChords);
                break;
            case 7:
                addBarObject (defaultSegmentBars, emChords);
                addBarObject (defaultSegmentBars, amChords);
                addBarObject (defaultSegmentBars, dChords);
                addBarObject (defaultSegmentBars, bmChords);
                break;
            case 8:
                addBarObject (defaultSegmentBars, emChords);
                addBarObject (defaultSegmentBars, gChords);
                addBarObject (defaultSegmentBars, dChords);
                addBarObject (defaultSegmentBars, emChords);
                break;
            case 9:
            default:
                addBarObject (defaultSegmentBars, emChords);
                addBarObject (defaultSegmentBars, bmChords);
                addBarObject (defaultSegmentBars, amChords);
                addBarObject (defaultSegmentBars, amChords);
                break;
        }
    }

    return defaultSegmentBars;
}
