/*
  ==============================================================================

    Exceptions.h
    Created: 10 Oct 2023 10:24:45am
    Author:  abhis

  ==============================================================================
*/

#pragma once
#include <stdexcept>
#include <exception>
#include <regex> // for std::regex and std::regex_match
#include <JuceHeader.h>

inline bool isValidEndpoint (const juce::String& endpointURL) {
    std::regex urlRegex (R"(^https?://)");
    return std::regex_search (endpointURL.toStdString(), urlRegex);
}

//TODO: Move this to a separate file called "ExceptionHandling.h"
class InvalidArgumentException : public std::runtime_error
{
public:
    explicit InvalidArgumentException (const juce::String& arg)
        : std::runtime_error ("Invalid argument: " + arg.toStdString()) {}
};

class GeneratorError : public std::runtime_error
{
public:
    explicit GeneratorError (const juce::String& message)
        : std::runtime_error ("Generator error: " + message.toStdString()) {}
};

class InvalidEndpointException : public std::runtime_error
{
public:
    explicit InvalidEndpointException (const juce::String& url)
        : std::runtime_error ("Invalid endpoint URL: " + url.toStdString()) {}
};
