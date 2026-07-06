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
        // Own the decoder so it is not leaked. If the cast fails, streamReader
        // still owns (and frees) the object when it goes out of scope.
        auto streamReader = mp3Format.createReader(in);
        if (auto* casted = dynamic_cast<choc::audio::AudioFileReader*> (streamReader.get()))
        {
            streamReader.release();
            reader.reset (casted);
        }

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

        loadedOk = true;
    }


    bool readSamples (int* const* destChannels,
                      int numDestChannels,
                      int startOffsetInDestBuffer,
                      juce::int64 startSampleInFile,
                      int numSamples) override
    {
        if (reader == nullptr || numSamples <= 0)
            return false;

        float* const* const dst = reinterpret_cast<float* const*> (destChannels);

        // Decode the requested region starting at startSampleInFile.
        const int srcChannels = juce::jmax (1, (int) numChannels);
        juce::AudioBuffer<float> buf (srcChannels, numSamples);
        buf.clear();

        auto result = choc::buffer::createChannelArrayView (buf.getArrayOfWritePointers(),
                                                            (uint32_t) buf.getNumChannels(),
                                                            (uint32_t) buf.getNumSamples());
        bool loaded = reader->readFrames ((uint64_t) startSampleInFile, result);

        // Honour numDestChannels and startOffsetInDestBuffer; never write past the
        // destination channels (dst[1] on a mono buffer would be out of bounds).
        for (int destChan = 0; destChan < numDestChannels; ++destChan)
        {
            if (dst[destChan] == nullptr)
                continue;

            const int srcChan = juce::jmin (destChan, buf.getNumChannels() - 1);
            const float* src = buf.getReadPointer (srcChan);

            for (int i = 0; i < numSamples; ++i)
                dst[destChan][startOffsetInDestBuffer + i] = src[i];
        }

        return loaded;
    }

    choc::audio::MP3AudioFileFormat mp3Format;
    std::unique_ptr<choc::audio::AudioFileReader> reader;
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
        // JUCE contract: return nullptr on failure (callers do not expect exceptions).
        if (sourceStream == nullptr)
            return nullptr;

        std::unique_ptr<ChocMP3AudioFormatReader> r;

        try
        {
            r = std::make_unique<ChocMP3AudioFormatReader> (sourceStream, "MP3");
        }
        catch (const std::exception&)
        {
            return nullptr;
        }

        if (r->loadedOk)
            return r.release();

        // On failure, only detach the stream when the caller wants to keep it.
        if (!deleteStreamIfOpeningFails)
            r->input = nullptr;

        return nullptr;
    }


    juce::AudioFormatWriter* createWriterFor (juce::OutputStream*, double, unsigned int, int, const juce::StringPairArray&, int) override
    {
        return {};
    }
};

