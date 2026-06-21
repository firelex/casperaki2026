//
// Created by Tiago Alves on 10/05/2022.
//

#ifndef SAMPLESDOWNLOADTASK_H
#define SAMPLESDOWNLOADTASK_H
#pragma once

#include <JuceHeader.h>

typedef std::shared_ptr<std::unordered_map<juce::String, juce::String>> FileMapPtr;

class SampleDownloader
{
public:
    SampleDownloader()
    {
        
    }
    
    FileMapPtr downloadSamples (tracktion_engine::Edit &_edit,
                                juce::String baseUrl, 
                                juce::String filePrefix,
                                juce::DynamicObject::Ptr _ids);
};

#endif // SAMPLESDOWNLOADTASK_H
