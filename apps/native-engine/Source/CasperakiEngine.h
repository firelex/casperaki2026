/*
  ==============================================================================

    CasperakiEngine.h
    Created: 27 Apr 2022 11:17:04am
    Author:  Tiago Alves

  ==============================================================================
*/

#define DBGEL(x) do { std::cout << "\n"; DBG(x); std::cout << "\n"; } while(0)

#pragma once
#include <JuceHeader.h>
#include "sequencer/Sequencer.h"
#include "./instruments/Instrument.h"
#include "./FX.h"
#include "./common.h"
#include <future>
// #include "ChocMP3AudioFormat.h"
#include "instruments/Drums.h"
#include "instruments/Bass.h"
#include "instruments/Synths.h"
#include "instruments/Guitar.h"
#include "instruments/Loop.h"
#include "instruments/TonalInstrument.h"
#include "instruments/TransitionSample.h"
#include "instruments/TransitionNoise.h"
#include "instruments/TransitionPattern.h"
#include <iostream>
#include <filesystem>
#include "config.h"

namespace fs = std::filesystem;


typedef std::function<void()> Callback;

class CasperakiEngine : private juce::ChangeListener, private juce::HighResolutionTimer
{
public:
    
    struct ControlState
    {
        std::string state { "stopped" };
        double position = 0.0;
        double length = 0.0;
        int step = 0;
        int beat = 0;
        int bar = 0;
        std::string segment { "intro" };
        int bpm = 90;
        std::string chord {"A"};

        bool operator== (const ControlState& b)
        {
            return
            (
                state == b.state &&
                position == b.position &&
                length == b.length &&
                step == b.step &&
                bpm == b.bpm &&
                chord == b.chord
            );
        }
    };

#if JUCE_PLUGINHOST_VST
    void scanExternalPlugins()
    {
        // Get the current executable's location
        juce::File currentExecutable = juce::File::getSpecialLocation(juce::File::currentApplicationFile);

        // Assuming engine and edit are accessible from this function
        auto& knownPluginList = engine->getPluginManager().knownPluginList;

        // Get the directory where external plugins are located
        juce::String currentDir = currentExecutable.getParentDirectory().getFullPathName();
        juce::String externalPluginPath;
        
#ifdef JUCE_WINDOWS
        externalPluginPath = currentDir + "\\ExternalPlugins\\Windows";
#elif JUCE_MAC
        externalPluginPath = currentDir + "/ExternalPlugins/Mac";
#elif defined(JUCE_LINUX) || defined(JUCE_BSD)
        // docs/57d Linux scan: register the Airwindows Consolidated VST3.
        // SimpleSide and ValhallaFreqEcho are RETIRED (docs/63 §6) — they are
        // now in-tree plugins (CasperakiSimpleSidePlugin / CasperakiFreqShiftEchoPlugin)
        // sharing the WASM DSP, registered as built-in types, so there is NO
        // external VST3/VST2 scan for them (and crucially no Wine/yabridge).
        {
            auto& knownPluginList = engine->getPluginManager().knownPluginList;
            juce::OwnedArray<juce::PluginDescription> descs;
            const auto home = juce::File::getSpecialLocation (juce::File::userHomeDirectory);

#if JUCE_PLUGINHOST_VST3
            juce::VST3PluginFormat vst3;
            const auto consolidated = home.getChildFile (".vst3").getChildFile ("Airwindows Consolidated.vst3");
            if (consolidated.exists()) {
                DBG ("[57d] scanning VST3 " << consolidated.getFullPathName());
                knownPluginList.scanAndAddFile (consolidated.getFullPathName(), true, descs, vst3);
            }
#endif

            DBG ("[57d] knownPluginList now has " << knownPluginList.getNumTypes() << " entries");
            return;
        }
#endif

        juce::File externalPluginsDirectory (externalPluginPath);

        // Check if the directory exists
        if (!externalPluginsDirectory.exists() || !externalPluginsDirectory.isDirectory()) {
            std::cerr << "You are missing your External Plugins directory..." << std::endl;
            return; // or throw an exception
        }

        // You can specify the file ending for your external plugins here
        juce::String externalFileEnding = AudioPluginUtils::getVST2FileEnding(); // for Windows as an example

        // Array to hold the plugin descriptions
        juce::OwnedArray<juce::PluginDescription> pluginDescriptions;
        juce::VSTPluginFormat vstPluginFormat;

        // Find all the plugins in the directory
        juce::Array<juce::File> pluginFiles = externalPluginsDirectory.findChildFiles(juce::File::findFilesAndDirectories, true, externalFileEnding);
        for (const auto& pluginFile : pluginFiles)
        {
            DBG ("Added pluginfile: " + pluginFile.getFullPathName());
            knownPluginList.scanAndAddFile (juce::String (pluginFile.getFullPathName()), true, pluginDescriptions, vstPluginFormat);
        }

        if (pluginFiles.size() == 0)
            std::cerr << "Error. There are no plugins";

        // Load all the scanned plugins
        for (const auto& pluginDescription : pluginDescriptions) {
            auto plug = edit->getPluginCache().createNewPlugin(te::ExternalPlugin::xmlTypeName, *pluginDescription);
            // Do whatever you need with the plugin instance
        }
    }
    
    void scanAirWindowsPlugins()
    {
        //this can cache all your plugins.
        auto& knownPluginList = engine->getPluginManager().knownPluginList;
        
        juce::String pluginDirectoryPath = AudioPluginUtils::getVST2PluginDirectoryPath();
        juce::String vst2FileEnding = AudioPluginUtils::getVST2FileEnding();
        
        // Path to the plugins directory
        juce::File pluginsDirectory (pluginDirectoryPath);

        // Check if the directory exists
        if (!pluginsDirectory.exists() || !pluginsDirectory.isDirectory()) {
            // Handle the error, maybe print a message or throw an exception
            std::cerr << "You are missing your VST plugin directory..." << std::endl;

            return; // or throw an exception
        }

        // These will be filled by the next function, so we get the pluginDescription
        juce::OwnedArray<juce::PluginDescription> pluginDescriptions;
        juce::VSTPluginFormat vstPluginFormat;



        // Iterate over all files in the directory
        juce::Array<juce::File> pluginFiles = pluginsDirectory.findChildFiles(juce::File::findFilesAndDirectories, true, vst2FileEnding);
        for (const auto& pluginFile : pluginFiles) {
            // Now you can add your plugin to the knownPluginList
            knownPluginList.scanAndAddFile (juce::String(pluginFile.getFullPathName()), true, pluginDescriptions, vstPluginFormat);
        }

        // Assuming you want to load all the scanned plugins
        for (const auto& pluginDescription : pluginDescriptions) {
            auto plug = edit->getPluginCache().createNewPlugin(te::ExternalPlugin::xmlTypeName, *pluginDescription);
            // Do whatever you need with the plugin instance
        }
    }

#endif
    
    void hiResTimerCallback() override
    {
        if (controlStateCallback && !preparingEdit)
        {
            ControlState newControlState = getControlState();
            if (newControlState == lastControlState)
            {
                return;
            }
            lastControlState = newControlState;
            controlStateCallback (lastControlState);
        }
    }
    
    CasperakiEngine (const std::function<void(ControlState)>&);
    
    ~CasperakiEngine()
    {

#if !SHOULD_RETAIN_PROJECT_FILES
        getEdit()->engine.getTemporaryFileManager().getTempFile("casperaki").setAsCurrentWorkingDirectory();
        //Delete edit folder
        auto editParentFolder = getEdit ()->editFileRetriever ().getParentDirectory ();
        editParentFolder.getParentDirectory ().getChildFile ("edit_" + getEdit ()->getProjectItemID ().toStringSuitableForFilename ()).deleteRecursively ();
        editParentFolder.deleteRecursively();
//        if (editParentFolder.exists())
//        {
//            editParentFolder.getParentDirectory().getChildFile ("edit_" + getEdit()->getProjectItemID().toStringSuitableForFilename()).deleteRecursively ();
//            editParentFolder.deleteRecursively();
//            if (editParentFolder.exists())
//            {
//                try
//                {
//                    fs::remove_all (editParentFolder.getFullPathName().toStdString());
//                    if (editParentFolder.exists())
//                    {
//                        std::string deleteCommand;
//#ifdef _WIN32 // Windows
//                        deleteCommand = "rmdir \"" + editParentFolder.getFullPathName().toStdString() + "\"";
//                        std::cout<<"Running command: " <<deleteCommand<<std::endl;
//#else // Unix-like systems (Linux, macOS)
//                        deleteCommand = "rm -rf \"" + editParentFolder.getFullPathName().toStdString() + "\"";
//#endif
//
//                        int result = std::system (deleteCommand.c_str());
//                        if (result == 0)
//                        {
//                            // Deletion succeeded
//                        }
//                        else
//                        {
//                            // Deletion failed, handle the error
//                        }
//                    }
//                }
//                catch (const std::filesystem::filesystem_error& e)
//                {
//                    std::cerr << "Error deleting folder: " << e.what() << std::endl;
//                }
//            }
//        }
#endif
        DBG ("CasperakiEngine DESTROYED!!!!");
    };
     
//mountboard 600 speed 55 power  0.05
    void initialise();

    void deleteEdit() {
        sequencer.reset();
        instruments.clear();

        // 55a port: v3 made DeviceManager::clearAllContextDevices private.
        // For the render-only spike we never created hardware-bound contexts,
        // so dropping this teardown step is safe.
        // engine->getDeviceManager().clearAllContextDevices();
        engine->getEditDeleter().deleteEdit(std::move(edit));

        edit = nullptr;
    }

    void prepareEdit(j::String editName = "");

    void play();

    void pause();

    void increaseTempo();

    void decreaseTempo();

    void stop();

    void addInstrument (std::string instrumentData, juce::String baseURL);
    
    void addInstrumentAsync (std::string instrumentDataStr, Callback finishedCallback, juce::String baseURL);
    
    template <typename Fn>
    void runAsync (Fn function, Callback finishedCallback)
    {
        auto runAsync = juce::Thread::launch ([&] 
        { 
            function(); 
            if (finishedCallback)
                finishedCallback();
        });
    }

    void removeInstrument (int instrumentId);

    void setSong (std::string songData);

    void setVibe (std::string vibeData);

    void setInstrumentMute (int instrumentId, bool mute);

    void setInstrumentPostVolume (int instrumentId, float db);

    void setBpm (double bpm);

    void seekTo (std::string segment, int bar, double step);

    void save();

    void testAsync (std::function<void()> callback);

    std::string createZipFile();

    void load();
    
    juce::ValueTree& getState();

    ControlState getControlState();
        
    void playNote (int instrumentId, std::string noteData);
    
    Instrument* findInstrument(int instrumentId);

    void changeVibe (std::string songData);
    
    te::Edit* getEdit()
    {
        return edit.get();
    }

    void initialiseSequencer (juce::String genre)
    {
        te::ArrangerTrack *arrangerTrack = edit->getArrangerTrack();
        te::ChordTrack *chordTrack = edit->getChordTrack();
        sequencer.reset (new Sequencer (*engine.get(), *edit.get(), instruments, genre));
        te::Clip *clip = arrangerTrack->insertNewClip (te::TrackItem::Type::arranger, "", te::timeRangeFromSamples (juce::Range<int64_t> (0, 44100), 44100), nullptr);
        auto arrangerClip = dynamic_cast<te::ArrangerClip *> (clip);
        jassert(arrangerClip != nullptr);

        if (arrangerClip) juce::Logger::writeToLog ("Sequencer has been initialized.");
    }

    bool wasLastGenerationSuccessful = false;
    bool getLastGenerationSuccessful() { return wasLastGenerationSuccessful; }

    //Exports song, and if successful, will return the exported song
    juce::File exportSongWithoutMelody (const juce::String fileName);
    juce::File exportSongWithMelody (const juce::String fileName);
    juce::File exportVocalMelody (const juce::String fileName);

#if JUCE_EMSCRIPTEN
    void addInstrumentEmscripten (std::string instrumentData);
#endif

private:
    std::function<void (ControlState)> controlStateCallback;

    void changeListenerCallback (juce::ChangeBroadcaster *source) override;

    std::unique_ptr<te::Engine> engine;
    std::unique_ptr<te::Edit> edit;
    te::TransportControl *transport;
    std::shared_ptr<Sequencer> sequencer;

    j::OwnedArray<Instrument> instruments {};
    ControlState lastControlState;

    bool preparingEdit = false;
    
    JUCE_DECLARE_NON_COPYABLE (CasperakiEngine);
};

typedef std::function<void(CasperakiEngine::ControlState)> ControlStateCallback;
