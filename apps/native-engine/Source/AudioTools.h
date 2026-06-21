#pragma once


inline void resampleAudioBuffer (juce::AudioBuffer<float>& inputBuffer, double inputSampleRate, double outputSampleRate)
{
    if (inputSampleRate <= 0 || outputSampleRate <= 0)
    {
        std::cerr << "Error: Invalid sample rates." << std::endl;
        return;
    }

    if (inputBuffer.getNumSamples() <= 0)
    {
        std::cerr << "Error: Empty input buffer." << std::endl;
        return;
    }

    int numInputChannels = inputBuffer.getNumChannels();
    int numInputSamples = inputBuffer.getNumSamples();

    // Calculate the resampling ratio and number of output samples
    double resamplingRatio = inputSampleRate / outputSampleRate;
    int numOutputSamples = std::ceil(numInputSamples / resamplingRatio);

    // Create a new buffer to hold the resampled audio
    juce::AudioBuffer<float> outputBuffer(numInputChannels, numOutputSamples);

    // Create a LagrangeInterpolator object
    juce::LagrangeInterpolator interpolator;

    // Iterate through the input buffer and use the interpolator to fill the output buffer
    for (int channel = 0; channel < 2; channel++)
    {
        const float* inputChannelData = inputBuffer.getReadPointer(channel);
        float* outputChannelData = outputBuffer.getWritePointer(channel);

        int numSamplesProcessed = interpolator.process(resamplingRatio, inputChannelData, outputChannelData, numOutputSamples);
        std::cout << "Channel " << channel << ": Processed " << numSamplesProcessed << " samples" << std::endl;
    }

    // Replace the input buffer with the resampled buffer
    inputBuffer.clear();
    inputBuffer.setSize(numInputChannels, numOutputSamples, false, true, true);
    for (int channel = 0; channel < numInputChannels; ++channel)
    {
        inputBuffer.copyFrom(channel, 0, outputBuffer, channel, 0, numOutputSamples);
    }

    std::cout << "Reached function end" << std::endl;
}

inline double getSampleRate (const File& audioFile)
{
    AudioFormatManager formatManager;
    formatManager.registerBasicFormats ();  // Register the basic audio formats (e.g., WAV, AIFF, etc.)

    std::unique_ptr<AudioFormatReader> reader (formatManager.createReaderFor (audioFile));

    if (reader)
    {
        return reader->sampleRate;
    }

    return -1.0;  // Return -1 or some error value if the file couldn't be read
}