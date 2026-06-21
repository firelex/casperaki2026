/*
  ==============================================================================

    ChocMP3AudioFormat.h
    Created: 6 Dec 2022 11:32:23am
    Author:  Abhishek Shivakumar

  ==============================================================================
*/

#pragma once
#include "../dependencies/choc/audio/choc_AudioFileFormat_MP3.h"
#include "../dependencies/choc/audio/choc_AudioFileFormat_WAV.h"

struct MemoryBuffer : std::streambuf
{
    MemoryBuffer (char* begin, char* end)
    {
        this->setg (begin, begin, end);
    }
};

class StreamWrapper : std::istream
{
    juce::InputStream* inputStream;
    
public:
    StreamWrapper (juce::InputStream* newInputStream) : std::istream (nullptr)
    {
        inputStream = newInputStream;
    }
    
    void seekg (int position)
    {
        inputStream->setPosition (position);
    }
};

class ChocMP3AudioFormatReader : public juce::AudioFormatReader
{
    
public:
    
    bool loadedOk = false;
    int dataStartOffset, bigEndian;

    ChocMP3AudioFormatReader (juce::InputStream* in, juce::String formatName) : AudioFormatReader(in, formatName)
    {
        auto streamReader = mp3Format.createReader(in);
        reader = dynamic_cast<choc::audio::AudioFileReader*> (streamReader.release());

        if (reader == nullptr)
        {
            loadedOk = false;
            return;
        }

        usesFloatingPointData = true;

        dataStartOffset = 0;
        sampleRate = reader->getProperties().sampleRate;
        lengthInSamples = reader->getProperties().numFrames;
        numChannels = reader->getProperties().numChannels;
        bitsPerSample = 16;

        if (reader != nullptr)
            loadedOk = true;
        else
            loadedOk = false;
    }
    

    bool readSamples (int* const* destChannels,
                      int numDestChannels,
                      int startOffsetInDestBuffer,
                      juce::int64 startSampleInFile,
                      int numSamples) override
    {
        float* const* const dst = reinterpret_cast<float* const*> (destChannels);
        
        auto beader = dynamic_cast<choc::audio::AudioFileReader*> (reader);
        juce::AudioBuffer<float> buf (numDestChannels, numSamples);
        choc::buffer::ChannelArrayView<float> result = choc::buffer::createChannelArrayView (buf.getArrayOfWritePointers(), buf.getNumChannels(), buf.getNumSamples());
        bool loaded = beader->readFrames (startOffsetInDestBuffer, result);
       
        
        auto outL = buf.getWritePointer (0);
        for (int i = 0; i < buf.getNumSamples(); ++i)
        {
            dst[0][i] = outL[i];
            dst[1][i] = outL[i];
        }
         
        return loaded;        
    }
    
    choc::audio::MP3AudioFileFormat mp3Format;
    choc::audio::AudioFileReader* reader;
};

class ChocMP3AudioFormat : public juce::AudioFormat
{
public:
    
    ChocMP3AudioFormat() : AudioFormat ("MP3", ".mp3")
    {
      
    }
    
    juce::Array<int> getPossibleSampleRates() override    { return {}; }
    juce::Array<int> getPossibleBitDepths() override      { return {}; }

    bool canDoStereo() override     { return true; }
    bool canDoMono() override       { return true; }
    bool isCompressed() override    { return true; }

    juce::AudioFormatReader* createReaderFor (juce::InputStream* sourceStream, bool deleteStreamIfOpeningFails) override
    {
        if (sourceStream == nullptr)
            throw std::invalid_argument ("sourceStream is null!");

        std::unique_ptr<ChocMP3AudioFormatReader> r;

        try
        {
            r = std::make_unique<ChocMP3AudioFormatReader> (sourceStream, "MP3");
        }
        catch (const std::exception& e)
        {
            throw std::runtime_error ("Failed to create ChocMP3AudioFormatReader: " + std::string (e.what()));
        }

        if (r->loadedOk)
            return r.release();

        if (!deleteStreamIfOpeningFails)
            r->input = nullptr;

        throw std::runtime_error ("ChocMP3AudioFormatReader failed to load.");
    }


    juce::AudioFormatWriter* createWriterFor (juce::OutputStream*, double, unsigned int, int, const juce::StringPairArray&, int) override
    {
        return {};
    }
};

