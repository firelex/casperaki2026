//
// Created by Tiago Alves on 29/04/2022.
//

#pragma once
#define JUCE_USE_MP3AUDIOFORMAT

#include <JuceHeader.h>

inline std::string getAssetFilePath (const juce::String resourcePath)
{
#if JUCE_ANDROID
    //    ZipFile apkZip (File::getSpecialLocation (File::invokedExecutableFile));
    //    return std::unique_ptr<InputStream> (apkZip.createStreamForEntry (apkZip.getIndexOfFileName ("assets/" + String (resourcePath))));
        return std::string{};
#else
#if JUCE_IOS
    auto assetsDir = File::getSpecialLocation (File::currentExecutableFile)
                          .getParentDirectory().getChildFile ("Assets");
#elif JUCE_MAC
    auto assetsDir = juce::File::getSpecialLocation(juce::File::currentExecutableFile)
        .getParentDirectory().getParentDirectory().getChildFile("Resources").getChildFile("Assets");
#elif JUCE_WINDOWS
    auto assetsDir = juce::File::getSpecialLocation (juce::File::currentExecutableFile)
            .getParentDirectory().getParentDirectory().getParentDirectory ().getParentDirectory ().getParentDirectory ().getParentDirectory ().getChildFile ("Assets");
#endif

    auto resourceFile = assetsDir.getChildFile(resourcePath);
    jassert (resourceFile.existsAsFile());

    return resourceFile.getFullPathName().toStdString();
#endif
}
