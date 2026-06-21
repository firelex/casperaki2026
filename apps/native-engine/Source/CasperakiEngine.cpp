/*
  ==============================================================================

    CasperakiEngine.cpp
    Created: 27 Apr 2022 11:17:04am
    Author:  Tiago Alves

  ==============================================================================
*/

#include "CasperakiEngine.h"
#include "airwindows_extras/CasperakiAirwindowsExtras.h"
#include "casperaki_fx/CasperakiFxPlugins.h"
using namespace tracktion_engine;

//This class, although functional, could still be improved.
//It could potentially be made to use multiple cores.
class CasperakiEngineBehaviour : public tracktion::EngineBehaviour {
 public:
  CasperakiEngineBehaviour (int newNumCPUsToUse = 1) : tracktion::EngineBehaviour ()
  {
      numCPUsToUse = newNumCPUsToUse;
  }

  int getNumberOfCPUsToUseForAudio () override
  {
      DBGEL("Number of CPUs available: " + juce::String (numCPUsToUse)); //Setting this to 1 disables multi-threading
      return numCPUsToUse;
  }

  bool autoInitialiseDeviceManager () override
  {return false;}

 private:

  int numCPUsToUse;
};

#if JUCE_MODAL_LOOPS_PERMITTED
class HeadlessUIBehaviour : public UIBehaviour {
 public:
  void runTaskWithProgressBar (ThreadPoolJobWithProgress &t) override
  {
      TaskRunner runner (t);

      while (runner.isThreadRunning ())
          if (!juce::MessageManager::getInstance ()->runDispatchLoopUntil (20))
              break;
  }

  HeadlessUIBehaviour () = default;

 private:
  struct TaskRunner : public juce::Thread {
      TaskRunner (ThreadPoolJobWithProgress &t)
          : juce::Thread (t.getJobName ()), task (t)
      {
          startThread ();
      }

      ~TaskRunner () override
      {
          task.signalJobShouldExit ();
          waitForThreadToExit (10000);
      }

      void run () override
      {
          while (!threadShouldExit ())
              if (task.runJob () == juce::ThreadPoolJob::jobHasFinished)
                  break;
      }

      ThreadPoolJobWithProgress &task;
  };
};
#endif

CasperakiEngine::CasperakiEngine (const ControlStateCallback& _controlStateCallback) : controlStateCallback(_controlStateCallback)
{
    initialise ();
}

void CasperakiEngine::testAsync(std::function<void()> callback)
{
    std::cout << "testAsync Hello I am Thread: " << j::Thread::getCurrentThreadId() << std::endl;
    j::Thread::launch([callback]()
        {
            std::cout << "thread Hello I am Thread: " << j::Thread::getCurrentThreadId() << std::endl;
            j::Thread::sleep(3000);
            callback();
        });
}

void CasperakiEngine::changeListenerCallback(juce::ChangeBroadcaster*)
{
    // transport state changed. do something
    // transport.isPlaying();
}

void CasperakiEngine::initialise()
{
    // initialise
    juce::Logger::writeToLog("Initialising Casperaki Engine.");

    auto messageManagerInstance = j::MessageManager::getInstance();

#if JUCE_MODAL_LOOPS_PERMITTED
    engine = std::make_unique<tracktion::Engine>(ProjectInfo::projectName,
                                                 std::unique_ptr<tracktion::UIBehaviour>(new HeadlessUIBehaviour()),
                                                 std::unique_ptr<tracktion::EngineBehaviour>(new CasperakiEngineBehaviour(std::max(1, juce::SystemStats::getNumCpus() - 1))));
#else
    engine = std::make_unique<tracktion::Engine>(ProjectInfo::projectName,
                                                 nullptr,
                                                 std::unique_ptr<tracktion::EngineBehaviour>(new CasperakiEngineBehaviour(std::max(1, juce::SystemStats::getNumCpus() - 1))));
#endif



    //Add custom casperaki plugin types
    // engine->getDeviceManager().initialise(0, 4);

    te::DeviceManager& deviceManager = engine->getDeviceManager();
    deviceManager.initialise(0, 4);

    // Then get the AudioDeviceManager.
    juce::AudioDeviceManager& audioDeviceManager = deviceManager.deviceManager;

    // Get current audio device
    juce::AudioIODevice* device = audioDeviceManager.getCurrentAudioDevice();

    // If there's a device available, set its properties
    if (device != nullptr)
    {
        juce::AudioDeviceManager::AudioDeviceSetup setup;
        audioDeviceManager.getAudioDeviceSetup(setup);

        setup.sampleRate = 44100; // Set your new sample rate here
        setup.bufferSize = 2205; // Set your new buffer size here (0.5 seconds)
        setup.inputChannels = 0;
        setup.outputChannels = 32;

        juce::String error = audioDeviceManager.setAudioDeviceSetup(setup, true);
        if (error.isNotEmpty())
        {
            juce::Logger::writeToLog("Unable to set audio device parameters: " + error);
        }
    }

    prepareEdit();

//    std::function<juce::AudioFormat* ()> mp3FormatCreator([] { return new ChocMP3AudioFormat(); });
//    edit.get()->engine.getAudioFileFormatManager().addFormat(mp3FormatCreator, false, false);

#if USE_CASPERAKI_SAMPLER
    engine->getPluginManager().createBuiltInType<CasperakiSamplerPlugin>();
#endif

    // docs/57d: register Tracktion's built-in plugin types (compressor,
    // 4bandEq, delay, AirWindows*, etc.) so the rack-XML remap can resolve
    // them via createPlugin. Without this, getPluginCache().createNewPlugin
    // returns null for airwindows_eq, compressor, etc. The smoke binary
    // (apps/engine-spike/native/plugin_smoke.cpp) verified this is needed
    // before plugins can be instantiated headlessly.
    engine->getPluginManager().initialise();
#if TRACKTION_AIR_WINDOWS
    engine->getPluginManager().initialiseAirWindows();
    // The 10 Casperaki-bundled Airwindows plugins (Console8 Sub/Buss
    // In/Out, kPlateA, kPlateD, TexturizeMS, StereoChorus, Huge, Air2)
    // not in Tracktion's AIRWINDOWSPLUGIN set. FXPluginRemap rewrites
    // legacy Windows DLL refs to their xmlTypeNames; these built-in
    // registrations are what makes those names resolvable.
    casperaki::airwindows_extras::registerCasperakiAirwindowsExtras(*engine);
#endif

    // docs/63 §6: the two RETIRED external VSTs (SimpleSide GPLv3,
    // ValhallaFreqEcho proprietary/Wine-bridged) are reimplemented as in-tree
    // plugins sharing the WASM render DSP. FXPluginRemap rewrites the legacy
    // refs to these xmlTypeNames, so registering them here makes the rewritten
    // racks resolvable WITHOUT loading any external VST (no yabridge/Wine).
    engine->getPluginManager().createBuiltInType<CasperakiFreqShiftEchoPlugin>();
    engine->getPluginManager().createBuiltInType<CasperakiSimpleSidePlugin>();

    edit->getMasterVolumePlugin()->setVolumeDb(-1.0f);


#if JUCE_PLUGINHOST_VST
    auto start = std::chrono::high_resolution_clock::now();
    scanExternalPlugins();

    // Stop the timer
    auto stop = std::chrono::high_resolution_clock::now();

    // Calculate duration
    auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(stop - start);

    // Print or log the duration
    std::cout << "Time taken to scan plugins: " << duration.count() << " milliseconds" << std::endl;

    DeferredLogger& logger = DeferredLogger::getInstance();
    logger.logMessage ("Time taken to scan plugins: " + juce::String (duration.count()) + " milliseconds");
#endif

    if (controlStateCallback != nullptr)
    {
        startTimer (100);
    }
}

void CasperakiEngine::prepareEdit(j::String editName)
{
    // resetEdit
    juce::Logger::writeToLog ("==========================================================================================================");
    juce::Logger::writeToLog ("\n");
    juce::Logger::writeToLog("CASPERAKI ENGINE RESET EDIT!");
    preparingEdit = true;

#if JUCE_EMSCRIPTEN
    engine->getTemporaryFileManager().setTempDirectory(juce::File{"/tempdata"});
#endif

    if (edit != nullptr)
    {
        edit->getTransport().removeChangeListener(this);
        edit->getTransport().stop(false, false);
        deleteEdit ();
    }

    // Spike patch (casperaki/apps/engine-spike): switch from forEditing to
    // forRendering so the Edit doesn't create an EditPlaybackContext that
    // demands a real audio output device. On WSL2/headless boxes this
    // produces zero output from te::Renderer::renderToFile even though
    // render completes "successfully". This is intentionally not upstreamed
    // to casperaki_engine yet — the engine still needs forEditing for the
    // live-transport paths.
    // 55a port: v2 Edit ctor became private in Tracktion v3. Switch to the
    // new Options-based ctor. Provide a synthetic ProjectItemID so the Edit
    // is happy with a non-default identity (rendering only — we never persist).
    te::Edit::Options editOpts {
        *engine,
        te::createEmptyEdit(*engine),
        te::ProjectItemID::createNewID(0)
    };
    editOpts.role = te::Edit::forRendering;
    editOpts.loadContext = nullptr;
    editOpts.numUndoLevelsToStore = 0;
    edit.reset(new te::Edit(std::move(editOpts)));
    transport = &(edit.get()->getTransport());

    // create edit file
    juce::File parentDirectory;
    if (editName == "")
    {
        parentDirectory = edit.get()->engine.getTemporaryFileManager().getTempFile("casperaki");
        juce::Logger::writeToLog("Found parent directory at: " + parentDirectory.getFullPathName());
    }
    else
    {
        j::String editDirectoryName{ editName };
        int repeatNumber = 1;
        do
        {
            editDirectoryName = { editName };
            editDirectoryName << "-" << repeatNumber++;
            parentDirectory = edit.get()->engine.getTemporaryFileManager().getTempFile(editDirectoryName);
        } while (parentDirectory.isDirectory());
    }

    parentDirectory.createDirectory();
    parentDirectory.setAsCurrentWorkingDirectory();

    j::File editFile = parentDirectory.getChildFile("edit.trkedit");

    edit.get()->editFileRetriever = [editFile]
    {
        return editFile;
    };

    save();

    transport->addChangeListener(this);

    instruments.clear();

    preparingEdit = false;

    //By this point, we have successfully saved a new, empty edit file for editing.
}

void CasperakiEngine::play()
{
    transport->play(false);
}

void CasperakiEngine::pause()
{
    auto& transport = edit->getTransport();
    transport.stop(false, false);
}

void CasperakiEngine::increaseTempo ()
{
    for (auto& tempo : edit->tempoSequence.getTempos ())
        tempo->setBpm (tempo->getBpm() + 10);
}

void CasperakiEngine::decreaseTempo()
{
    for (auto& tempo : edit->tempoSequence.getTempos ())
        tempo->setBpm (tempo->getBpm() - 10);
}

void CasperakiEngine::stop()
{
    pause();
    seekTo("", 0, 0);
}

void CasperakiEngine::setBpm(double bpm)
{
    edit->tempoSequence.insertTempo(te::BeatPosition::fromBeats(0), bpm, 0);
}

CasperakiEngine::ControlState CasperakiEngine::getControlState()
{
    /*
        std::string state { "stopped" };
        double position = 0.0;
        double length = 0.0;
        int step = 0;
        int beat = 0;
        int bar = 0;
        std::string segment { "intro" };
        int bpm = 90;
        std::string chord {"A"};
     */

    te::EditPlaybackContext* playbackContext = transport->getCurrentPlaybackContext();
    te::TimePosition currentAbsTime = playbackContext->getPosition();

    te::ArrangerTrack* arrangerTrack = edit->getArrangerTrack();
    te::Clip* segmentClip = nullptr;

    for (auto clip : arrangerTrack->getClips())
    {
        if (clip->getEditTimeRange().contains(currentAbsTime))
        {
            segmentClip = clip;
            break;
        }
    }

    te::BeatPosition currentRelBeat;
    std::string segmentName{};

    if (segmentClip)
    {
        auto segmentClipEditTimeRange = segmentClip->getEditTimeRange();
        currentRelBeat = edit->tempoSequence.toBeats(
            currentAbsTime - te::TimeDuration::fromSeconds(segmentClipEditTimeRange.getStart().inSeconds()));
        segmentName = segmentClip->getName().toStdString();
    }

    return ControlState
    {
        transport->isPlaying() ? "playing" : "stopped",
        isnan(currentAbsTime.inSeconds()) ? 0 : currentAbsTime.inSeconds(),
        edit->getLength().inSeconds(),
        (int)(fmod(currentRelBeat.inBeats(), 4) * 8),
        (int)floor(currentRelBeat.inBeats()) % 4,
        (int)floor(currentRelBeat.inBeats()) / 4,
        segmentName,
        (int)edit->tempoSequence.getBpmAt(currentAbsTime),
        std::string{"A"},
    };
}

void CasperakiEngine::save()
{
    (*edit).flushState();

    te::EditFileOperations editFileOperations{ *edit };

    std::cout << "Saving edit to: " << edit->editFileRetriever().getFullPathName() << " exists: " << edit->editFileRetriever().exists() << std::endl;

    editFileOperations.save(false, true, false);

    transport->setLoopRange ({ tracktion::TimePosition::fromSeconds(0), edit->getLength() });
}

std::string CasperakiEngine::createZipFile()
{
    j::ZipFile::Builder zip;

    j::File editFolder = edit->editFileRetriever().getParentDirectory();
    auto editFolderParent = editFolder.getParentDirectory();
    {
        for (const auto& i : j::RangedDirectoryIterator(editFolder, true, "*", j::File::findFiles))
        {
            if (!i.getFile().isHidden())
                zip.addFile(i.getFile(), 9, i.getFile().getRelativePathFrom(editFolderParent));
        }
    }

    j::File targetFile = editFolderParent.getChildFile("casperaki.zip");
    juce::Logger::writeToLog("Writing: " + targetFile.getFullPathName());

    //TODO: Inspect this function.
    j::FileOutputStream out(targetFile);

    if (!(out.openedOk() && zip.writeToStream(out, nullptr)))
        j::ConsoleApplication::fail("Failed to write to the target file: " + targetFile.getFullPathName());


    return targetFile.getFullPathName().toStdString();
}

void CasperakiEngine::load()
{
    (*edit).flushState();

    const juce::File editFile("./test.trkedit");

    edit = te::loadEditFromFile(*engine, editFile);
}

juce::ValueTree& CasperakiEngine::getState()
{
    return (*edit).state;
}

void CasperakiEngine::addInstrumentAsync(std::string instrumentDataStr, Callback finishedCallback, juce::String baseURL)
{
    juce::Thread::launch([this, instrumentDataStr, finishedCallback, baseURL]
        {
            addInstrument(instrumentDataStr, baseURL);

            if (finishedCallback)
                finishedCallback();
        });
}

/* This function is async and contains a callback */
void CasperakiEngine::addInstrument(std::string instrumentDataStr, juce::String baseURL)
{
    DBG ("ADDING INSTRUMENT. DATA: " + j::String((int)instrumentDataStr.length()));
    j::var instrumentData = j::JSON::parse(instrumentDataStr);

    DBG ("data is object " + j::String(instrumentData.isObject() ? "true" : "false") + " "
        + instrumentData["type"].toString());

    if (!instrumentData.isObject())
    {
        juce::Logger::writeToLog("Something is seriously wrong. The instrument data below is not a valid object:");
        juce::Logger::writeToLog("Instrument Data String: " + instrumentData.toString());
    }

    // check if instrument already exists
    int instrumentId = Instrument::getInstrumentId(instrumentData);
    bool instrumentAlreadyExists = std::any_of(instruments.begin(), instruments.end(), [instrumentId](Instrument* instrument)
        {
            return instrument->id == instrumentId;
        });

    if (instrumentAlreadyExists)
    {
        DBG ("Instrument " + j::String(instrumentId) + " already exists. Skipping add instrument");
        return;
    }

    switch (Instrument::getType(instrumentData["type"].toString()))
    {
    case Instrument::Type::drums:
    {
        instruments.add(std::move(new Drums(*edit, instrumentData, baseURL)));
        break;
    }
    case Instrument::Type::basses:
    {
        instruments.add(new Bass(*edit, instrumentData, baseURL));
        break;
    }
    case Instrument::Type::leadSynths:
    case Instrument::Type::synths:
    case Instrument::Type::keys:
    case Instrument::Type::popBrass:
    case Instrument::Type::popStrings:
    case Instrument::Type::orchestral:
    case Instrument::Type::vocals:
        instruments.add(new Synths(*edit, instrumentData, baseURL));
        break;
    case Instrument::Type::acousticGuitars:
    case Instrument::Type::electricGuitars:
        instruments.add(new Guitar(*edit, instrumentData, baseURL));
        break;
    case Instrument::Type::loop:
        instruments.add(new Loop(*edit, instrumentData, baseURL));
        break;
    case Instrument::Type::transitionSample:
        instruments.add(new TransitionSample(*edit, instrumentData, baseURL));
        break;
    case Instrument::Type::transitionNoise:
        instruments.add(new TransitionNoise(*edit, instrumentData, baseURL));
        break;
    case Instrument::Type::transitionPattern:
        instruments.add(new TransitionPattern(*edit, instrumentData, baseURL));
        break;
    default:
        TRACKTION_LOG("Instrument type not found: " + instrumentData["type"].toString());
        break;
    }

    //if (auto lastInstrument = static_cast<TransitionNoise*> (instruments.getLast()))
    //{
    //    lastInstrument->initPlugins();
    //}

    DBG ("ADDED INSTRUMENT. count: " + juce::String(instruments.size()) + " name: " + (*instruments[instruments.size() - 1]).name);
}

void CasperakiEngine::removeInstrument(int instrumentId)
{
    Instrument* instrument = findInstrument(instrumentId);
    if (instrument == nullptr)
        return;

    std::cout << "REMOVING INSTRUMENT: " << instrument->name << std::endl;
    instruments.removeObject(findInstrument(instrumentId));
}

Instrument* CasperakiEngine::findInstrument(int instrumentId)
{
    for (auto inst : instruments)
    {
        if ((inst)->id == instrumentId)
        {
            return inst;
        }
    }
    return nullptr;
}

void CasperakiEngine::setSong(std::string songDataStr)
{
    std::cout << "SET SONG. DATA LENGTH: " << songDataStr.length() << std::endl;

    std::vector<int> indicesToRemove;

    for (int i = 0; i < instruments.size(); ++i)
    {
        for (int j = i + 1; j < instruments.size(); ++j)
        {
            if (instruments.getUnchecked(i)->id == instruments.getUnchecked(j)->id)
            {
                indicesToRemove.push_back(j);
            }
        }
    }

    // Remove duplicate elements in reverse order
    for (auto it = indicesToRemove.rbegin(); it != indicesToRemove.rend(); ++it)
    {
        instruments.remove(*it, true); // deleteObject = true
    }

    j::var songData = j::JSON::parse(songDataStr);

//    DBG("Genre is: " + songData["genre"].toString());
    initialiseSequencer(songData["genre"].toString());

    // juce::Logger::writeToLog ("Song Data: " + juce::String (songDataStr));

//    DBG("Patterns: " + songData["patterns"].toString());

    std::cout << "tempo " << songData["patterns"]["tempo"].toString() << std::endl;

    sequencer->setSong(songData);
    std::cout << "SET SONG DONE" << std::endl;

    save();
}

void CasperakiEngine::setInstrumentMute(int instrumentId, bool mute)
{
    Instrument* inst = findInstrument(instrumentId);

    for (auto track : inst->getAudioTracks())
        track->setMute(mute);

    std::cout << "INSTRUMENT MUTE: " << inst->name << " -> " << mute << std::endl;
}

void CasperakiEngine::setInstrumentPostVolume(int instrumentId, float db)
{
    Instrument* inst = findInstrument(instrumentId);

    for (auto track : inst->getAudioTracks())
        applyPostVolumeToTrack(*edit.get(), track, db);

    std::cout << "INSTRUMENT VOLUME: " << inst->name << " -> " << db << std::endl;
}

void CasperakiEngine::seekTo(std::string segment, int bar, double step)
{
    te::ArrangerTrack* arrangerTrack = edit->getArrangerTrack();
    te::TimePosition segmentStart;

    if (!segment.empty() && arrangerTrack->getClips().size() > 0)
    {
        for (auto clip : arrangerTrack->getClips())
        {
            if (clip->getName().toStdString() == segment)
            {
                segmentStart = clip->getEditTimeRange().getStart();
                break;
            }
        }
    }

    double newPosition = segmentStart.inSeconds() +
        edit->tempoSequence.toTime(te::BeatPosition::fromBeats(bar * 4 + step / 8.0)).inSeconds();
    //edit->tempoSequence.barsBeatsToTime(te::TempoSequence::BarsAndBeats{bar, step/8});

    // 55a port: v3 TransportControl::setCurrentPosition removed; use setPosition(TimePosition).
    edit->getTransport().setPosition(te::TimePosition::fromSeconds(newPosition));

    std::cout << "SEEK TO: " << newPosition << std::endl;
}

void CasperakiEngine::playNote(int instrumentId, std::string noteDataStr)
{
    //Engine, edit and transport have already been created

    if (engine == nullptr)
    {
        juce::Logger::writeToLog("Engine has not been initialized. Unable to Play Note");
        return;
    }
    if (edit == nullptr)
    {
        juce::Logger::writeToLog("Edit has not been created. Unable to Play Note");
        return;
    }

    //Find an instrument from its ID, assuming it has already been added to the instrument array
    auto instrumentToPlay = findInstrument(instrumentId);//findInstrument (26142); //bass 4
    if (instrumentToPlay == nullptr)
    {
        juce::Logger::writeToLog("Instrument has not been loaded. Unable to Play Note");
        return;
    }

    transport->ensureContextAllocated();
    instrumentToPlay->playNote(noteDataStr);
}


juce::File CasperakiEngine::exportSongWithoutMelody (const juce::String fileName)
{
    j::Time time = j::Time::getCurrentTime();

    juce::Logger::writeToLog("Start export. Size: " + juce::String(edit->getLength().inSeconds()) + " seconds.");
    j::String exportLocation("export/");
    exportLocation << fileName << ".wav";

#if JUCE_ANDROID
    j::File exportFile = j::File::getSpecialLocation(j::File::userApplicationDataDirectory).getChildFile(exportLocation);

#else
    j::File exportFile = j::File::getSpecialLocation(j::File::currentApplicationFile).getParentDirectory().getChildFile(exportLocation);
#endif

    //We ensure that the exportFile has write access
    if (!exportFile.hasWriteAccess())
    {
        std::cerr << exportFile.getFullPathName() << " does not have write access." << std::endl;
        return {};
    }

    exportFile.getParentDirectory().createDirectory();
    exportFile.deleteFile();

    te::TimeRange range{ {}, edit->getLength() };

    if (edit != nullptr)
        std::cout << "The edit has a length of (in seconds): " << juce::String(edit->getLength().inSeconds()) << std::endl;

    juce::BigInteger tracksToDo{ 0 };

    juce::Array<tracktion_engine::Clip*> clips;

    /* if should do all tracks except vocals */ 
    for (auto i = 0; i < te::getAllTracks(*edit).size(); i++)
    {
        auto track = te::getAllTracks(*edit)[i];
        if (track == edit->getMasterTrack()
         || (track->getName() != "vocals"
         && track->getName() != "Lead vocals")
            )
        {
            tracksToDo.setBit(i);
        }
    }

    /* if should just do vocals */
    for (auto i = 0; i < te::getAllTracks(*edit).size(); i++)
    {
        auto track = te::getAllTracks(*edit)[i];
        if (track->getName() == "vocals"
         || track->getName() == "Lead vocals"
            )
        {
            tracksToDo.setBit(0);
        }
    }


    juce::Logger::writeToLog("tracksToDo: " + tracksToDo.toString(2));

//    te::Renderer::Parameters r(*edit);
//    r.tracksToDo = tracksToDo;
//    r.time = range;
//    r.audioFormat = edit.get()->engine.getAudioFileFormatManager().getWavFormat();
//    r.destFile = exportFile;
//    r.sampleRateForAudio = 44100;
//    r.separateTracks = true;

    juce::Logger::writeToLog("Exporting to: " + exportFile.getFullPathName());

    std::cout << "made it this far" << std::endl;

    auto start = std::chrono::high_resolution_clock::now();

#if JUCE_MODAL_LOOPS_PERMITTED
    te::Renderer::renderToFile ("export song", exportFile, *edit, range, tracksToDo, true, true, {}, true); // 55a: v3 adds useACID
#else
    te::Renderer::renderToFile ("export song", exportFile, *edit, range, tracksToDo, true, true, {}, false); // 55a: v3 adds useACID
#endif
//    auto job = tracktion::EditRenderJob::getOrCreateRenderJob (edit->engine, r, false, false, false);
    //jassert (job != nullptr);
    //edit->engine.getUIBehaviour().runTaskWithProgressBar (*job);

    // Stop the timer
    auto stop = std::chrono::high_resolution_clock::now();

    // Calculate duration
    auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(stop - start);

    // Print or log the duration
    std::cout << "Time taken to render: " << duration.count() << " milliseconds" << std::endl;

    juce::Logger::writeToLog("Exported to: " + exportFile.getFullPathName() + " time: " + juce::String(j::Time::getCurrentTime().toMilliseconds() - time.toMilliseconds()) + "ms");

    DeferredLogger& logger = DeferredLogger::getInstance();
    logger.logMessage("Time taken to render song: " + juce::String(j::Time::getCurrentTime().toMilliseconds() - time.toMilliseconds()) + "ms");

    std::cout << ("Successfully exported file to: " + exportFile.getFullPathName()) << std::endl;
    wasLastGenerationSuccessful = true;

    return exportFile;
}

juce::File CasperakiEngine::exportSongWithMelody (const juce::String fileName)
{
    j::Time time = j::Time::getCurrentTime();

    juce::Logger::writeToLog("Start export. Size: " + juce::String(edit->getLength().inSeconds()) + " seconds.");
    j::String exportLocation("export/");
    exportLocation << fileName << ".wav";

    j::File exportFile = j::File::getSpecialLocation(j::File::currentApplicationFile).getParentDirectory().getChildFile(exportLocation);

    //We ensure that the exportFile has write access
    if (!exportFile.hasWriteAccess())
    {
        std::cerr << exportFile.getFullPathName() << " does not have write access." << std::endl;
        return {};
    }

    exportFile.getParentDirectory().createDirectory();
    exportFile.deleteFile();

    te::TimeRange range{ {}, edit->getLength() };

    if (edit != nullptr)
        std::cout << "The edit has a length of (in seconds): " << juce::String(edit->getLength().inSeconds()) << std::endl;

    juce::BigInteger tracksToDo{ 0 };

    juce::Array<tracktion_engine::Clip*> clips;

    /* if should do all tracks except vocals */ 
    for (auto i = 0; i < te::getAllTracks(*edit).size(); i++)
    {
        auto track = te::getAllTracks(*edit)[i];
        if (track->canContainAudio() || track == edit->getMasterTrack())
        {
            tracksToDo.setBit(i);
        }
    }

    juce::Logger::writeToLog("tracksToDo: " + tracksToDo.toString(2));

    te::Renderer::Parameters r(*edit);
    r.tracksToDo = tracksToDo;
    r.time = range;
    r.audioFormat = edit.get()->engine.getAudioFileFormatManager().getWavFormat();
    r.destFile = exportFile;
    r.sampleRateForAudio = 44100;
//    r.separateTracks = true;

    juce::Logger::writeToLog("Exporting to: " + exportFile.getFullPathName());

    std::cout << "made it this far" << std::endl;

    auto start = std::chrono::high_resolution_clock::now();

    te::Renderer::renderToFile ("export song", exportFile, *edit, range, tracksToDo, true, true, {}, true); // 55a: v3 adds useACID

    //auto job = tracktion::EditRenderJob::getOrCreateRenderJob (edit->engine, r, false, false, false);
    //jassert (job != nullptr);
    //edit->engine.getUIBehaviour().runTaskWithProgressBar (*job);

    // Stop the timer
    auto stop = std::chrono::high_resolution_clock::now();

    // Calculate duration
    auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(stop - start);

    // Print or log the duration
    std::cout << "Time taken to render: " << duration.count() << " milliseconds" << std::endl;

    juce::Logger::writeToLog("Exported to: " + exportFile.getFullPathName() + " time: " + juce::String(j::Time::getCurrentTime().toMilliseconds() - time.toMilliseconds()) + "ms");

    DeferredLogger& logger = DeferredLogger::getInstance();
    logger.logMessage("Time taken to render song: " + juce::String(j::Time::getCurrentTime().toMilliseconds() - time.toMilliseconds()) + "ms");

    std::cout << ("Successfully exported file to: " + exportFile.getFullPathName()) << std::endl;
    wasLastGenerationSuccessful = true;

    return exportFile;
}


juce::File CasperakiEngine::exportVocalMelody (const juce::String fileName)
{
    j::Time time = j::Time::getCurrentTime();

    juce::Logger::writeToLog("Start export. Size: " + juce::String(edit->getLength().inSeconds()) + " seconds.");
    j::String exportLocation("export/");
    exportLocation << fileName << "_melody.wav";

    j::File exportFile = j::File::getSpecialLocation(j::File::currentApplicationFile).getParentDirectory().getChildFile(exportLocation);

    //We ensure that the exportFile has write access
    if (!exportFile.hasWriteAccess())
    {
        std::cerr << exportFile.getFullPathName() << " does not have write access." << std::endl;
        return {};
    }

    exportFile.getParentDirectory().createDirectory();
    exportFile.deleteFile();

    te::TimeRange range{ {}, edit->getLength() };

    if (edit != nullptr)
        std::cout << "The edit has a length of (in seconds): " << juce::String(edit->getLength().inSeconds()) << std::endl;

    juce::BigInteger tracksToDo{ 0 };

    juce::Array<tracktion_engine::Clip*> clips;

    /* if should just do vocals */
    for (auto i = 0; i < te::getAllTracks(*edit).size(); i++)
    {
        auto track = te::getAllTracks(*edit)[i];
        if (track == edit->getMasterTrack()
         || track->getName() == "vocals"
         || track->getName() == "MASTER"
         || track->getName() == "Lead vocals"
            )
        {
            tracksToDo.setBit(i);
        }
    }

    juce::Logger::writeToLog("tracksToDo: " + tracksToDo.toString(2));

    te::Renderer::Parameters r(*edit);
    r.tracksToDo = tracksToDo;
    r.time = range;
    r.audioFormat = edit.get()->engine.getAudioFileFormatManager().getWavFormat();
    r.destFile = exportFile;
    r.sampleRateForAudio = 44100;
//    r.separateTracks = true;

    juce::Logger::writeToLog("Exporting to: " + exportFile.getFullPathName());

    std::cout << "made it this far" << std::endl;

    auto start = std::chrono::high_resolution_clock::now();

    te::Renderer::renderToFile ("export song", exportFile, *edit, range, tracksToDo, true, true, {}, true); // 55a: v3 adds useACID

    // Stop the timer
    auto stop = std::chrono::high_resolution_clock::now();

    // Calculate duration
    auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(stop - start);

    // Print or log the duration
    std::cout << "Time taken to render: " << duration.count() << " milliseconds" << std::endl;

    juce::Logger::writeToLog("Exported to: " + exportFile.getFullPathName() + " time: " + juce::String(j::Time::getCurrentTime().toMilliseconds() - time.toMilliseconds()) + "ms");

    DeferredLogger& logger = DeferredLogger::getInstance();
    logger.logMessage("Time taken to render song: " + juce::String(j::Time::getCurrentTime().toMilliseconds() - time.toMilliseconds()) + "ms");

    std::cout << ("Successfully exported file to: " + exportFile.getFullPathName()) << std::endl;
    wasLastGenerationSuccessful = true;

    return exportFile;
}

#if JUCE_EMSCRIPTEN

void CasperakiEngine::addInstrumentEmscripten(std::string instrumentDataStr) {
    addInstrument(instrumentDataStr, "https://staging.casperaki.com");
}

#include <emscripten/bind.h>

// // Binding code
EMSCRIPTEN_BINDINGS(casperaki_engine)
{
    emscripten::class_<CasperakiEngine>("CasperakiEngine")
        .function("addInstrument", &CasperakiEngine::addInstrumentEmscripten)
        .function("removeInstrument", &CasperakiEngine::removeInstrument)
        .function("setInstrumentMute", &CasperakiEngine::setInstrumentMute)
        .function("setInstrumentPostVolume", &CasperakiEngine::setInstrumentPostVolume)
        .function("setSong", &CasperakiEngine::setSong)
        .function("play", &CasperakiEngine::play)
        .function("pause", &CasperakiEngine::pause)
        .function("stop", &CasperakiEngine::stop)
        .function("seekTo", &CasperakiEngine::seekTo)
        .function("getControlState", &CasperakiEngine::getControlState)
        .function("save", &CasperakiEngine::save)
        .function("createZipFile", &CasperakiEngine::createZipFile)
        .function("playNote", &CasperakiEngine::playNote);

    emscripten::value_object<CasperakiEngine::ControlState>("ControlState")
        .field("state", &CasperakiEngine::ControlState::state)
        .field("position", &CasperakiEngine::ControlState::position)
        .field("length", &CasperakiEngine::ControlState::length)
        .field("step", &CasperakiEngine::ControlState::step)
        .field("beat", &CasperakiEngine::ControlState::beat)
        .field("bar", &CasperakiEngine::ControlState::bar)
        .field("segment", &CasperakiEngine::ControlState::segment)
        .field("bpm", &CasperakiEngine::ControlState::bpm)
        .field("chord", &CasperakiEngine::ControlState::chord);
}
#endif
