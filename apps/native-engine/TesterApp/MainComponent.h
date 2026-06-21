#pragma once

#include <JuceHeader.h>

#include "./ValueTreeViewer.h"
#include "../Source/InstrumentalGenerator.h"
#include <future>

//==============================================================================
/*
    This component lives inside our window, and this is where you should put all
    your controls and content.
*/
class MainComponent : public juce::Component
{
public:
    //==============================================================================
    MainComponent();

    ~MainComponent() override;

    //==============================================================================
    void paint(juce::Graphics &) override;

    void resized() override;

private:
    //==============================================================================
    // Your private member variables go here...
    bool isWaitingForInstrumental = false;

    juce::String projectName = "New Project";

    // header components
    juce::Label titleLabel;
    juce::TextButton exportButton{"Export"};
    juce::TextButton saveButton{"Save"};

    // tree view components
    juce::Label treeLabel;
    ValueTreeViewer treeView;

    // player controls
    juce::TextButton rewindButton{"<<"};
    juce::TextButton playPauseButton{">"};;
    juce::TextButton forwardButton{">>"};
    juce::Label timeLabel{juce::String(), "0.0 / 0.0"};
    juce::Label beatLabel{juce::String(), "- / -"};

    // load controls
    juce::ComboBox pickJsonsCombo {"load song"};
    juce::TextButton loadJsonButton {"load song"};

    // debug info
    juce::TextEditor debugTextEditor;

    CasperakiEngine::ControlState controlState;
    std::shared_ptr<CasperakiEngine> casperakiEngine;
    std::unique_ptr<InstrumentalGenerator> instrumentalGenerator;

    void loadPreparedSongData(json preparedSongData);

    void timerCallback (CasperakiEngine::ControlState controlState1);

    void togglePlayPause();

    void save();

    void load();

    void exportSong();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainComponent)

    void loadJson();

    void loadEngine();

    void removeInstrument(int value);

    void setInstrumentVolume(int instrumentId, float db);

    void setWaitingForInstrumental(bool waitingForInstrumental);
};

