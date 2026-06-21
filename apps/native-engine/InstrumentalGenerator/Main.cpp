/*
  ==============================================================================

    This file contains the basic startup code for a JUCE application.

  ==============================================================================
*/

#define JucePlugin_Build_Standalone 1 // Necessary for headless application
#include <JuceHeader.h>
#include "../Source/Exceptions.h"
#include "../Source/config.h"

#if SHOULD_RUN_TESTS
#include "../Source/"
#else
#include "../Source/InstrumentalGenerator.h"
#endif

typedef std::function<void(int, char **)> CommandHandler;

std::map<juce::String, CommandHandler> commandHandlers;

// Function prototypes
void ensureEnoughArguments(int argc, int minRequired);
juce::File ensureDirectoryExists(const juce::String &path);
juce::File ensureFileExists(const juce::String &path);
void setVerbosityAndLogging(int argc, char *argv[], int verbosityArgIndex, juce::String name);
void handleGenerateMasteredSongFromJson(int argc, char *argv[]);
void handleRunTests(int argc, char *argv[]);
void handleGenerateMixed(int argc, char *argv[]);

void displayHelpInformation()
{
    std::cout << "Abhi Tool: Command Line Usage\n";
    std::cout << "Note: the [] around --verbose, --logFile, and --logFileVerbose implies that they are optional\n\n";
    std::cout << "--generate_mastered_song_from_json <instrumentalJSONPath> <endpointURL> [--verbose / --logFile / --logFileVerbose]\n";
    std::cout << "\tGenerate a mastered song from a JSON file.\n\n";
    std::cout << "--generate_mixed <audioFilePath> <jsonFilePath> <endpointURL> [--verbose / --logFile / --logFileVerbose]\n";
    std::cout << "\tGenerate a mixed song from an audio file and a JSON file.\n\n";
    std::cout << "--run_tests <genre> [--verbose / --logFile / --logFileVerbose]\n";
    std::cout << "\tRun tests for a specified genre.\n\n";
    std::cout << "--help\n";
    std::cout << "\tDisplay this help information.\n";
}

int main(int argc, char *argv[])
{
    juce::ScopedJuceInitialiser_GUI juceInit; // Necessary for headless application
    std::cout << ("Starting Abhi Tool") << std::endl;

#ifdef JUCE_DEBUG
    Logger::setCurrentLogger(new DebugLogger());
#else
    Logger::setCurrentLogger(new ReleaseLogger());
#endif

    try
    {
#if SHOULD_RUN_TESTS
        auto testRunner = std::make_unique<UnitTestRunner>();
        testRunner->setPassesAreLogged(true);
        testRunner->runTests({&tests});
        return 0;
#endif
        const std::map<juce::String, void (*)(int, char **)> actionMap =
            {
                {"--generate_mastered_song_from_json", handleGenerateMasteredSongFromJson},
                {"--generate_mixed", handleGenerateMixed},
                {"--run_tests", handleRunTests}};

        if (argc <= 1)
        {
            std::cerr << "Error: No arguments provided" << std::endl;
            return 1;
        }

        juce::String flag = argv[1];

        if (flag == "--help" || flag == "-help" || flag == "-h")
        {
            displayHelpInformation();
            return 1;
        }

        auto actionIt = actionMap.find(flag);
        if (actionIt != actionMap.end())
        {
            auto start = std::chrono::high_resolution_clock::now();

            actionIt->second(argc, argv);

            // Stop the timer
            auto stop = std::chrono::high_resolution_clock::now();

            // Calculate duration
            auto duration = std::chrono::duration_cast<std::chrono::seconds>(stop - start);

            DeferredLogger &logger = DeferredLogger::getInstance();
            logger.logMessage("Time taken to complete entire Instrumental Generator task: " + juce::String(duration.count()) + " seconds");
        }
        else
        {
            std::cerr << "Unknown flag: " << flag << std::endl;
            return 1;
        }
    }
    catch (const std::exception &e)
    {
        std::cerr << "Error: " << e.what() << '\n';
        return 1;
    }
    catch (...)
    {
        std::cerr << "Unknown error occurred.\n";
        return 1;
    }

    DeferredLogger &logger = DeferredLogger::getInstance();
    logger.flushMessages();

    delete (juce::Logger::getCurrentLogger());

    return 0;
}

// Function implementations

void ensureEnoughArguments(int argc, int minRequired)
{
    if (argc < minRequired)
        throw InvalidArgumentException("Not enough arguments provided.");
}

juce::File ensureDirectoryExists(const juce::String &path)
{
    juce::File directory(path);
    if (!directory.isDirectory())
        throw InvalidArgumentException("The provided path is not a directory.");
    return directory;
}

juce::File ensureFileExists(const juce::String &path)
{
    juce::File file(path);
    if (!file.existsAsFile())
        throw InvalidArgumentException("The provided file does not exist.");
    return file;
}

void setVerbosityAndLogging(int argc, char *argv[], int verbosityArgIndex, juce::String name)
{
    if (argc > verbosityArgIndex)
    {
        juce::String flag = argv[verbosityArgIndex];
        if (flag == "--verbose")
            static_cast<ReleaseLogger *>(Logger::getCurrentLogger())->setVerbosity(true);
        else if (flag == "--logFile")
        {
            Logger::setCurrentLogger(new ReleaseLogger(juce::File::getSpecialLocation(juce::File::SpecialLocationType::currentExecutableFile)
                                                           .getParentDirectory()
                                                           .getChildFile("logs")
                                                           .getFullPathName(),
                                                       "", name));
        }
        else if (flag == "--logFileVerbose")
        {
            Logger::setCurrentLogger(new ReleaseLogger(juce::File::getSpecialLocation(juce::File::SpecialLocationType::currentExecutableFile)
                                                           .getParentDirectory()
                                                           .getChildFile("logs")
                                                           .getFullPathName(),
                                                       "", name));
            static_cast<ReleaseLogger *>(Logger::getCurrentLogger())->setVerbosity(true);
        }
    }
}

void handleRunTests(int argc, char *argv[])
{
    ensureEnoughArguments(argc, 3);

    juce::String endpointURL = "https://staging.casperaki.com";
    bool shouldMaster = true;
    juce::String genre = argv[2];
    setVerbosityAndLogging(argc, argv, 4, genre);
    juce::String jsonFileName = "Stefan_" + genre + juce::String(1) + "_json";
    auto generator = std::make_unique<InstrumentalGenerator>(endpointURL);

    int dataSize;
    const char *jsonData = BinaryData::getNamedResource(jsonFileName.toRawUTF8(), dataSize);

    if (jsonData != nullptr && dataSize > 0)
    {
        juce::String myJsonString = juce::String::fromUTF8(jsonData, dataSize);
        generator->generateInstrumentalFromJSON(myJsonString, false, shouldMaster);
    }
    else
    {
        DBG("Couldn't find JSON file: " + jsonFileName);
    }
}

void handleGenerateMixed(int argc, char *argv[])
{
    ensureEnoughArguments(argc, 5); // Ensure correct number of arguments

    // Extract paths from arguments
    juce::String audioFilePath = argv[2];
    juce::String jsonFilePath = argv[3];
    juce::String endpointURL = argv[4];

    // Validate audio file path
    juce::File audioFile = ensureFileExists(audioFilePath);

    // Validate JSON file path and read content
    juce::File jsonFile = ensureFileExists(jsonFilePath);
    juce::String jsonText = jsonFile.loadFileAsString();
    if (jsonText.isEmpty())
    {
        throw std::runtime_error("The JSON file is empty.");
    }

    // Parse JSON and validate it contains necessary properties
    auto jsonVar = juce::JSON::parse(jsonText);
    if (!jsonVar.isObject())
    {
        throw std::runtime_error("Invalid JSON format.");
    }

    // Retrieve title from JSON to use for logging or processing
    auto *jsonObject = jsonVar.getDynamicObject();
    juce::var titleVar = jsonObject->getProperty("title");
    if (titleVar.isVoid() || titleVar.toString().isEmpty())
    {
        throw std::runtime_error("The JSON does not have a 'title' field.");
    }

    // Set verbosity and logging based on the title
    juce::String name = titleVar.toString();
    setVerbosityAndLogging(argc, argv, 5, name);

    // Initialize MelodyGenerator with JSON properties
    std::unique_ptr<InstrumentalGenerator> generator;
    juce::File editParentFolder;
    juce::String projectItemIDString;

    TIME_LOGGED_EXECUTION([&]
                          { generator = std::make_unique<InstrumentalGenerator>(endpointURL); },
                          "Generator Initialization");

    auto instrumentalBuffer = readAudioFromFile(audioFilePath);

    juce::File melodyFile;
    TIME_LOGGED_EXECUTION([&]
                          { melodyFile = generator->generateMelodyFromJSON(jsonFilePath); },
                          "Melody Generation");

    // Add audio file to melody buffer here
    auto melodyBuffer = readAudioFromFile(melodyFile);

    const int startSample = 0; // Starting at the beginning of the buffer
    const float gain = 1.0f;   // Assuming full volume

    // Determine the minimum number of samples to mix based on the shorter buffer
    const int numSamplesToMix = jmin(instrumentalBuffer.getNumSamples(), melodyBuffer.getNumSamples());

    // Mix in the melodyBuffer to instrumentalBuffer for each channel
    for (int channel = 0; channel < instrumentalBuffer.getNumChannels(); ++channel)
    {
        // If melodyBuffer has enough channels, use its own channel data
        if (channel < melodyBuffer.getNumChannels())
        {
            instrumentalBuffer.addFrom(channel, startSample, melodyBuffer.getReadPointer(channel), numSamplesToMix, gain);
        }
        else
        { // If melodyBuffer has fewer channels, mix its first channel into the remaining channels of instrumentalBuffer
            instrumentalBuffer.addFrom(channel, startSample, melodyBuffer.getReadPointer(0), numSamplesToMix, gain);
        }
    }

    exportFileToWAVPath(instrumentalBuffer, "export/" + titleVar.toString() + "_mixedFile.wav", 44100);

    // Obtain generated output details
    editParentFolder = generator->getEditParentFolder();
    projectItemIDString = generator->getProjectItemIDAsSuitableFilenameString();

    // Clean up if necessary
    generator.reset(); // Explicitly release the generator resource if needed

#if !SHOULD_RETAIN_PROJECT_FILES
    // Remove temporary project files if not required to retain
    if (editParentFolder.exists())
        editParentFolder.deleteFile();
    editParentFolder.getParentDirectory().getChildFile("edit_" + projectItemIDString).deleteRecursively();
#endif
}

void handleGenerateMasteredSongFromJson(int argc, char *argv[])
{
    bool shouldRenderMelody = false;
    ensureEnoughArguments(argc, 4);

    juce::String instrumentalJSONPath = argv[2];
    juce::String endpointURL = argv[3];

    // Check for the --melody flag
    for (int i = 4; i < argc; ++i)
    {
        if (juce::String(argv[i]) == "--melody")
        {
            shouldRenderMelody = true;
            break;
        }
    }

    juce::File instrumentalJSONFile = ensureFileExists(instrumentalJSONPath);
    juce::String jsonText = instrumentalJSONFile.loadFileAsString();
    if (jsonText != "")
    {
        auto jsonVar = juce::JSON::parse(jsonText);
        if (jsonVar.isObject())
        {
            auto *jsonObject = jsonVar.getDynamicObject();
            juce::var titleVar = jsonObject->getProperty("title");

            if (titleVar.isVoid() || titleVar.toString().isEmpty())
            {
                throw std::runtime_error("The JSON does not have a 'title' field.");
            }

            juce::String name = titleVar.toString();
            setVerbosityAndLogging(argc, argv, 4, name);
        }
        else
        {
            throw std::runtime_error("Invalid JSON format.");
        }
    }
    else
    {
        throw std::runtime_error("The JSON is empty.");
    }

    if (!isValidEndpoint(endpointURL))
    {
        throw InvalidEndpointException(endpointURL);
    }

    juce::File editParentFolder;
    juce::String projectItemIDString;
    {
        std::unique_ptr<InstrumentalGenerator> generator;

        TIME_LOGGED_EXECUTION([&]
                              { generator = std::make_unique<InstrumentalGenerator>(endpointURL); },
                              "Generator Initialization");

        TIME_LOGGED_EXECUTION([&]
                              { generator->generateInstrumentalFromJSONFile(instrumentalJSONPath, shouldRenderMelody, true); },
                              "Generation (not including initialization)");

        editParentFolder = generator->getEditParentFolder();
        projectItemIDString = generator->getProjectItemIDAsSuitableFilenameString();
        generator.reset();
    }

#if !SHOULD_RETAIN_PROJECT_FILES
    if (editParentFolder.exists())
        editParentFolder.deleteFile();
    editParentFolder.getParentDirectory().getChildFile("edit_" + projectItemIDString).deleteRecursively();
#endif
}
