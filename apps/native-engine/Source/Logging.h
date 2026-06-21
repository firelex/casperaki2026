/*
  ==============================================================================

    Logging.h
    Created: 10 Oct 2023 10:20:30am
    Author:  abhis

  ==============================================================================
*/

#pragma once
#include <Juceheader.h>
#include <chrono>
using namespace juce;

class DeferredLogger : public juce::Logger
{
    std::vector<juce::String> messageBuffer;

public:
    static DeferredLogger& getInstance()
    {
        static DeferredLogger instance;
        return instance;
    }

    void logMessage (const juce::String& message) override
    {
        messageBuffer.push_back(message);
    }

    void flushMessages()
    {
        for (const auto& message : messageBuffer)
        {
            std::cout << message << std::endl;
        }
        messageBuffer.clear();
    }
};

class TimeLogger 
{
public:
    void logExecutionTime (std::function<void()> func) 
    {
        auto start = std::chrono::high_resolution_clock::now();
        func();
        auto stop = std::chrono::high_resolution_clock::now();
        auto duration = std::chrono::duration_cast<std::chrono::seconds>(stop - start);
        std::cout << "Time taken: " << duration.count() << " seconds" << std::endl;
    }
};

class ReleaseLogger : public juce::Logger
{
    bool isVerbose = false;

    juce::String header;
    std::unique_ptr<juce::FileLogger> fileLogger;

public:
    ReleaseLogger(const juce::File& logDir, const juce::String& logHeader, juce::String name)
    : header(logHeader)
    {
        createFileLogger (logDir, name);
    }

    ReleaseLogger()
    {
    }

    void logMessage (const juce::String& message) override
    {
        if (isVerbose)
        {
            std::cout << message << std::endl;
            if (fileLogger != nullptr)
                fileLogger->logMessage(message);
        }
    }

    void setVerbosity (bool verbosity)
    {
        isVerbose = verbosity;
    }

    void disableFileLogging()
    {
        fileLogger.reset();
    }

    void createFileLogger (const juce::File& logDir, const juce::String& rootName)
    {
        juce::String dateStamp = juce::Time::getCurrentTime().formatted ("%Y-%m-%d_%H-%M-%S");
        juce::File logFile = logDir.getChildFile (rootName + "_" + dateStamp + ".txt");
        fileLogger = std::make_unique<juce::FileLogger> (logFile, header);
    }

private:

};

class DebugLogger : public Logger
{
public:
    void logMessage (const String& message) override
    {
        DBG (message);
    }
};

inline void TIME_LOGGED_EXECUTION (std::function<void()> code_block, const std::string& messageString) {
    auto start = std::chrono::high_resolution_clock::now();
    code_block();
    auto stop = std::chrono::high_resolution_clock::now();
    auto duration = std::chrono::duration_cast<std::chrono::seconds>(stop - start).count();
    DeferredLogger& logger = DeferredLogger::getInstance();
    logger.logMessage("Time taken for " + juce::String(messageString) + ": " + juce::String(duration) + " seconds");
}
