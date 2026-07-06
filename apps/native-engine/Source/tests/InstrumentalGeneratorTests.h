///*
//  ==============================================================================
//
//    InstrumentalGeneratorTests.h
//    Created: 13 Jun 2023 4:58:37pm
//    Author:  Abhishek Shivakumar
//
//  ==============================================================================

#pragma once
#include <JuceHeader.h>
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>
#include "../InstrumentalGenerator.h"

#include <future> // for std::future and std::async
#include <chrono> // for std::chrono
#include <condition_variable>
#include <mutex>
#include <thread>


//All of this is currently running in debug.
class InstrumentalGeneratorTests : public juce::UnitTest
{
public:
    InstrumentalGeneratorTests () : juce::UnitTest ("InstrumentalGeneratorTests")
    {
    }

    void runTest () override
    {
        //This only works on Abhishek's system... local file paths.
 //       beginTest ("ChocMP3DecoderTests");
 //       runAllChocDecoderTests();


   //     beginTest ("Generate Instrumental from JSONS for each genre");
   //     runGenerateInstrumentalFromJsonFolderTest (true);

//        beginTest ("Run Matchering Test");
//        generateMasteredInstrumentalTest (BinaryData::matcheringBallad_json, BinaryData::matcheringBallad_jsonSize);

//        beginTest ("Run track record");
//        generateMasteredInstrumentalTest (BinaryData::trackCleanup_json, BinaryData::trackCleanup_jsonSize);


//        beginTest ("Run Rock Strum Test");
//        generateMasteredInstrumentalTest (BinaryData::strumTest_json, BinaryData::strumTest_jsonSize);

        //For now, we're comparing the abhi tool to legacy unmastered -> ballad to start with

        //beginTest("Run ballad Test");
        //generateMasteredInstrumentalTest(BinaryData::ballad_json, BinaryData::ballad_jsonSize);

        //beginTest("Run bright pop Test");
        //generateMasteredInstrumentalTest(BinaryData::brightPop_json, BinaryData::brightPop_jsonSize);

        //beginTest("Run EDM Test");
        //generateMasteredInstrumentalTest(BinaryData::edm_json, BinaryData::edm_jsonSize);

        //beginTest("Run Rock Test");
        //generateMasteredInstrumentalTest(BinaryData::genreRock_json, BinaryData::genreRock_jsonSize);

//        beginTest ("Run local test");
//        generateMasteredInstrumentalTest (BinaryData::testSong_json, BinaryData::testSong_jsonSize);

        //beginTest ("Run Song Generation Test Prior to E2E");
        //generateMasteredInstrumentalTest (BinaryData::stringsjson_json, BinaryData::stringsjson_jsonSize);

 //       generateMasteredInstrumentalTest (BinaryData::wong4_json, BinaryData::wong4_jsonSize);
 //       generateMasteredInstrumentalTest (BinaryData::song4_json, BinaryData::song4_jsonSize);
 //       generateMasteredInstrumentalTest (BinaryData::song5_json, BinaryData::song5_jsonSize);
//        generateMasteredInstrumentalTest (BinaryData::song6_json, BinaryData::song6_jsonSize);
        //generateMasteredInstrumentalTest (BinaryData::weirdjson_json, BinaryData::weirdjson_jsonSize);
//        generateMasteredInstrumentalTest (BinaryData::testSong_json, BinaryData::testSong_jsonSize);

//        beginTest("rock test");
//        runRockTest();
//
//        beginTest ("Mastering test");
//        runMasteringTest();

//        beginTest ("Strummer Guitar test");
//        runStrummerGuitarTest ();

//        beginTest ("Mastering test");
//        runMasteringTest();

//        beginTest ("Run Generate Insturmental from genre tests");
//        runGenerateInstrumentalFromGenreTests();

        //beginTest ("ballad 1 test");
        //generateMasteredInstrumentalTest (BinaryData::Stefan_brightPop1_json, BinaryData::Stefan_brightPop1_jsonSize);

        //beginTest ("ballad 1 test");
        //generateMasteredInstrumentalTest (BinaryData::september_json_json, BinaryData::september_json_jsonSize);
//
        //beginTest("brightpop 1 test");
        //generateMasteredInstrumentalTest(BinaryData::stringsjson_json, BinaryData::stringsjson_jsonSize);

//        beginTest ("rock test");
//        generateMasteredInstrumentalTest (BinaryData::Stefan_rock1_json, BinaryData::Stefan_rock1_jsonSize);

        //beginTest ("strings test");
        //generateMasteredInstrumentalTest (BinaryData::stringsjson_json, BinaryData::stringsjson_jsonSize);

        //beginTest("automation test");
        //generateMasteredInstrumentalTest(BinaryData::automationtesting_json, BinaryData::automationtesting_jsonSize);

//        beginTest("Latin test");
//        generateMasteredInstrumentalTest (BinaryData::Stefan_latin1_json, BinaryData::Stefan_latin1_jsonSize);

//        beginTest ("wong vibe test");
//        generateMasteredInstrumentalTest (BinaryData::wong4_json, BinaryData::wong4_jsonSize);

        //beginTest("automation test for 235 second song");
        //generateMasteredInstrumentalTest (BinaryData::_235seconds_json_txt, BinaryData::_235seconds_json_txtSize);

        //beginTest ("Generating Vibes for all genres.");
        //runGenerateVibesForAllGenresTest();

        //beginTest ("Run Quality test.");
        //generateMasteredInstrumentalTest (BinaryData::qualitytest1_json, BinaryData::qualitytest1_jsonSize);

        //beginTest ("final phase");
        //runGenerateInstrumentalFromJsonFolderTest (true);

//        beginTest ("organicVibes");
//        generateMasteredInstrumentalTest (BinaryData::Stefan_brightPop1_json, BinaryData::Stefan_brightPop1_jsonSize);

//        beginTest ("Run Quality test.");
//        generateMasteredInstrumentalTest (BinaryData::Stefan_urban1_json, BinaryData::Stefan_urban1_jsonSize);



//beginTest ("pitch test1");
//generateMasteredInstrumentalTest (BinaryData::stefantest1_json, BinaryData::stefantest1_jsonSize);
//
beginTest ("pitch test2");
generateMasteredInstrumentalTest (BinaryData::pitchoff_json_json, BinaryData::pitchoff_json_jsonSize);

  //      beginTest ("melody test");
  //      runMelodyTest ();

    }

private:
    juce::File ensureDirectoryExists (const juce::String& path)
    {
        juce::File directory (path);
        if (!directory.isDirectory ())
            throw InvalidArgumentException ("The provided path is not a directory.");
        return directory;
    }

    juce::File ensureFileExists (const juce::String& path)
    {
        juce::File file (path);
        if (!file.existsAsFile ())
            throw InvalidArgumentException ("The provided file does not exist.");
        return file;
    }


    void handleGenerateMelody (juce::String audioFilePath, juce::String jsonFilePath, juce::String endpointURL)
    {
        // Validate audio file path
        juce::File audioFile = ensureFileExists (audioFilePath);

        // Validate JSON file path and read content
        juce::File jsonFile = ensureFileExists (jsonFilePath);
        juce::String jsonText = jsonFile.loadFileAsString ();
        if (jsonText.isEmpty ())
        {
            throw std::runtime_error ("The JSON file is empty.");
        }

        // Parse JSON and validate it contains necessary properties
        auto jsonVar = juce::JSON::parse (jsonText);
        if (!jsonVar.isObject ())
        {
            throw std::runtime_error ("Invalid JSON format.");
        }

        // Retrieve title from JSON to use for logging or processing
        auto* jsonObject = jsonVar.getDynamicObject ();
        juce::var titleVar = jsonObject->getProperty ("title");
        if (titleVar.isVoid () || titleVar.toString ().isEmpty ())
        {
            throw std::runtime_error ("The JSON does not have a 'title' field.");
        }

        // Set verbosity and logging based on the title
        juce::String name = titleVar.toString ();

        // Initialize MelodyGenerator with JSON properties
        std::unique_ptr<InstrumentalGenerator> generator;
        juce::File editParentFolder;
        juce::String projectItemIDString;

        TIME_LOGGED_EXECUTION ([&] {
            generator = std::make_unique<InstrumentalGenerator> (endpointURL);
            }, "Generator Initialization");

        auto instrumentalBuffer = readAudioFromFile (audioFilePath);

        juce::File melodyFile;
        TIME_LOGGED_EXECUTION ([&] {
            melodyFile = generator->generateMelodyFromJSON (jsonFilePath);
            }, "Melody Generation");


        //Add audio file to melody buffer here
        auto melodyBuffer = readAudioFromFile (melodyFile);
        // clamp to the destination length (mirror the non-test copy which uses jmin)
        const int mixNumSamples = juce::jmin (instrumentalBuffer.getNumSamples (), melodyBuffer.getNumSamples ());
        instrumentalBuffer.addFrom (0, 0, melodyBuffer.getReadPointer (0), mixNumSamples, 1.0f);

        if (melodyBuffer.getNumChannels () == 2)
        {
            instrumentalBuffer.addFrom (1, 0, melodyBuffer.getReadPointer (1), mixNumSamples, 1.0f);
        }
        else
        {
            instrumentalBuffer.addFrom (1, 0, melodyBuffer.getReadPointer (0), mixNumSamples, 1.0f);
        }

        exportFileToWAVPath (instrumentalBuffer, "export/" + titleVar.toString () + "_mixedFile", 44100);

        // Obtain generated output details
        editParentFolder = generator->getEditParentFolder ();
        projectItemIDString = generator->getProjectItemIDAsSuitableFilenameString ();

        // Clean up if necessary
        generator.reset ();  // Explicitly release the generator resource if needed

#if !SHOULD_RETAIN_PROJECT_FILES
        // Remove temporary project files if not required to retain
        if (editParentFolder.exists ())
            editParentFolder.deleteFile ();
        editParentFolder.getParentDirectory ().getChildFile ("edit_" + projectItemIDString).deleteRecursively ();
#endif
    }


    void runMelodyTest ()
    {
        // Your provided strings
        std::string command = "--generate_melody";
        std::string audioFilePath = "C:\\Users\\abhis\\batchutility\\Builds\\VisualStudio2022\\x64\\Release\\ConsoleApp\\export\\e2eTest-1697897990610_unmastered.wav";
        std::string jsonFilePath = "C:\\Users\\abhis\\batchutility\\Source\\tests\\InstrumentalPitchTesting\\pitchoff.json.json";
        std::string endpointURL = "https://staging.casperaki.com";

        // Convert them into an array of C-strings
        const char* arguments[] = {
            command.c_str (),
            audioFilePath.c_str (),
            jsonFilePath.c_str (),
            endpointURL.c_str ()
        };

        // Call handleGenerateMelody with argument count and argument vector
        handleGenerateMelody (audioFilePath, jsonFilePath, endpointURL);

    }
    void runGenerateInstrumentalFromGenreTests ()
    {
        juce::String endpointURL = "https://staging.casperaki.com";
        juce::Array<juce::String> genres = { "rock", "edm", "ballad", "brightPop" , "latin" , "organicVibes", "schlager" };
        for (const auto& genre : genres)
        {
            auto generator = std::make_unique<InstrumentalGenerator> (endpointURL);

            const juce::String testName = "GenerateInstrumentalFromGenre: " + genre;
            generator->generateInstrumentalBulk (genre, 1, endpointURL);
            expect (generator->hasGeneratedInstrumental (), "Failed to generate instrumental from genre: " + genre);
        }
    }

    bool readMP3File (const juce::String& filePath)
    {
        juce::AudioFormatManager formatManager;
        formatManager.registerBasicFormats ();
        //      formatManager.registerFormat(new ChocMP3AudioFormat(), false);

        juce::File audioFile (filePath);
        if (audioFile.exists ())
        {
            try
            {
                std::unique_ptr<juce::AudioFormatReader> audioReader (formatManager.createReaderFor (audioFile));

                if (audioReader == nullptr)
                {
                    logMessage ("Failed to read audio file");
                    return false;
                }
            }
            catch (const std::exception& e)
            {
                // Handle or log the exception
                logMessage ("Exception occurred while reading the audio file: " + juce::String (e.what ()));
                return false;
            }
        }

        std::cout << (filePath) << std::endl;
        return true;
    }



    bool readMP3FileWithTimeout (const juce::String& filePath)
    {
        // Share prom/done via shared_ptr captured by value: on timeout the read
        // thread is detached and may outlive this function, so it must not touch
        // stack locals by reference.
        auto prom = std::make_shared<std::promise<bool>> ();
        std::future<bool> future = prom->get_future ();
        auto done = std::make_shared<std::atomic<bool>> (false);

        std::thread readThread ([this, filePath, prom, done]() {
            bool result = readMP3File (filePath);
            if (!done->load ()) {
                prom->set_value (result);
            }
            });

        std::thread timerThread ([&future, done, this]()
            {
                if (future.wait_for (std::chrono::milliseconds (100)) == std::future_status::timeout)
                {
                    done->store (true);
                    logMessage ("Timeout occurred");
                }
            });

        timerThread.join ();
        if (done->load ())
        {
            readThread.detach (); // We don't care about this thread anymore.
            return false; // A timeout occurred.
        }
        readThread.join ();

        return future.get ();
    }

    void runAllChocDecoderTests ()
    {
        juce::String itunesFolderPath = "C:\\Users\\abhis\\Downloads\\casperaki_test\\itunes";
        juce::String convertedFolderPath = "C:\\Users\\abhis\\Downloads\\casperaki_test\\converted";


        juce::String logicBounceTestFolderPath = "C:\\Users\\abhis\\Downloads\\test files Abhi\\test files Abhi\\Test Logic Bounce";
        juce::String logicSaveTestFolderPath = "C:\\Users\\abhis\\Downloads\\test files Abhi\\test files Abhi\\Test Logic Save";
        juce::String izotopeBounceTestFolderPath = "C:\\Users\\abhis\\Downloads\\test files Abhi\\test files Abhi\\Test Izotope";

        //        DBG ("Running test for Izotope Bounced MP3s.");
        //        readMP3File (izotopeBounceTestFolderPath + "\\izotopetest1.mp3");

        //        DBG ("1. Running test for MP3s Bounced by Logic.");
        //        processMP3FilesInFolder (logicBounceTestFolderPath);

        //        DBG ("2. Running test for MP3s Saved by Logic.");
        //        processMP3FilesInFolder (logicSaveTestFolderPath);

        DBG ("3. Running test for MP3s - Itunes");
        processMP3FilesInFolder (itunesFolderPath);

        DBG ("4. Running test for MP3s - Converted");
        processMP3FilesInFolder (convertedFolderPath);
    }

    void processMP3FilesInFolder (const juce::String& folderPath)
    {
        juce::File folder (folderPath);

        if (!folder.isDirectory ())
        {
            juce::Logger::writeToLog ("Error: " + folderPath + " is not a valid directory");
            return;
        }

        juce::Array<juce::File> files;
        folder.findChildFiles (files, juce::File::findFiles, true, "*.mp3");

        for (const juce::File& file : files)
        {
            juce::String filePath = file.getFullPathName ();
            readMP3FileWithTimeout (filePath);
        }
    }

    void generateInstrumentalTest (const char* json, const int& jsonSize)
    {
        auto start = std::chrono::high_resolution_clock::now ();

        juce::String endpointURL = "https://staging.casperaki.com";
        auto generator = std::make_unique<InstrumentalGenerator> (endpointURL);
        juce::String myJsonString = juce::String::fromUTF8 (json, jsonSize);
        generator->generateInstrumentalFromJSON (myJsonString, true);
        expect (generator->hasGeneratedInstrumental (), "Failed to generate instrumental from JSON");

        // Stop the timer
        auto stop = std::chrono::high_resolution_clock::now ();

        // Calculate duration
        auto duration = std::chrono::duration_cast<std::chrono::seconds>(stop - start);

        DeferredLogger& logger = DeferredLogger::getInstance ();
        logger.flushMessages ();

        // Print or log the duration
        std::cout << "Time taken to complete entire Instrumental Generator task: " << duration.count () << " seconds" << std::endl;
    }

    void initializeGeneratorAndParseJSON (std::unique_ptr<InstrumentalGenerator>& generator, const char* json, const int& jsonSize, juce::String& myJsonString) {
        generator = std::make_unique<InstrumentalGenerator> ("https://staging.casperaki.com");
        myJsonString = juce::String::fromUTF8 (json, jsonSize);
    }

    void performGenerationAndLoggingTest (std::unique_ptr<InstrumentalGenerator>& generator, const juce::String& jsonString) {
        generator->generateInstrumentalFromJSON (jsonString, true, true);
        expect (generator->hasGeneratedInstrumental (), "Failed to generate instrumental from JSON");
    }

    void generateMasteredInstrumentalTest (const char* json, const int& jsonSize)
    {
        juce::String jsonString;
        juce::String endpointURL = "https://staging.casperaki.com";
        std::unique_ptr<InstrumentalGenerator> generator;

        TIME_LOGGED_EXECUTION ([&] {
            TIME_LOGGED_EXECUTION ([&] {
                initializeGeneratorAndParseJSON (generator, json, jsonSize, jsonString);
                }, "Generator Initialization & JSON Parsing:");

            TIME_LOGGED_EXECUTION ([&] {
                performGenerationAndLoggingTest (generator, jsonString);
                }, "Time taken to complete generation task:");
            }, "Time taken to complete entire task.");

        auto logger = DeferredLogger::getInstance ();
        logger.flushMessages ();
    }

    void runGenerateVibesForAllGenresTest ()
    {
        generateMasteredInstrumentalTest (BinaryData::ballad_vibe_json, BinaryData::ballad_vibe_jsonSize);
        generateMasteredInstrumentalTest (BinaryData::rock_vibe_json, BinaryData::rock_vibe_jsonSize);
        generateMasteredInstrumentalTest (BinaryData::edm_vibe_json, BinaryData::edm_vibe_jsonSize);
        generateMasteredInstrumentalTest (BinaryData::brightPop_vibe_json, BinaryData::brightPop_vibe_jsonSize);
        generateMasteredInstrumentalTest (BinaryData::urban_vibe_json, BinaryData::urban_vibe_jsonSize);
        generateMasteredInstrumentalTest (BinaryData::organicVibe_vibe_json, BinaryData::organicVibe_vibe_jsonSize);
    }

    void runGenerateInstrumentalFromJsonFolderTest (bool shouldMaster)
    {
        juce::String endpointURL = "https://staging.casperaki.com";

        // List all your genres
        juce::Array<juce::String> genres = { "ballad", "brightPop", "schlager", "urban", "edm", "organicVibes", "rock", "latin" };

        for (const auto& genre : genres)
        {
            for (int i = 1; i <= 2; i++) // assuming there are two json files per genre
            {
                juce::String jsonFileName = "Stefan_" + genre + juce::String (i) + "_json";
                auto generator = std::make_unique<InstrumentalGenerator> (endpointURL);

                int dataSize;
                const char* jsonData = BinaryData::getNamedResource (jsonFileName.toRawUTF8 (), dataSize);

                if (jsonData != nullptr && dataSize > 0)
                {
                    juce::String myJsonString = juce::String::fromUTF8 (jsonData, dataSize);
                    generator->generateInstrumentalFromJSON (myJsonString, shouldMaster);
                    expect (generator->hasGeneratedInstrumental (), "Failed to generate instrumental from JSON: " + jsonFileName);
                }
                else
                {
                    DBG ("Couldn't find JSON file: " + jsonFileName);
                }
            }
        }
    }

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (InstrumentalGeneratorTests)
};

static InstrumentalGeneratorTests tests;
