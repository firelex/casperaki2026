#include "MainComponent.h"

#include "./utils.h"

//==============================================================================
MainComponent::MainComponent()
{
    casperakiEngine = std::make_shared<CasperakiEngine>([&](CasperakiEngine::ControlState controlState1)
                                                        { timerCallback (controlState1); });

    setSize (800, 600);

    // header
    titleLabel.setText(projectName, juce::NotificationType::dontSendNotification);
    titleLabel.setColour(juce::Label::ColourIds::textColourId, juce::Colours::white);
    titleLabel.setColour(juce::Label::ColourIds::backgroundColourId, juce::Colours::black);
    titleLabel.setJustificationType(juce::Justification::centred);
    addAndMakeVisible (titleLabel);
    // saveButton.setEnabled(false);
    saveButton.onClick = [this]
    {
        save();
    };
    addAndMakeVisible (saveButton);
    exportButton.onClick = [this]
    {
        exportSong();
    };
    addAndMakeVisible (exportButton);

    // tree view
    treeLabel.setText ("Edit value tree", juce::NotificationType::dontSendNotification);
    treeLabel.setJustificationType (juce::Justification::bottomLeft);
    addAndMakeVisible (treeLabel);
    addAndMakeVisible (treeView);

    // player controls
    rewindButton.setEnabled(false);
    addAndMakeVisible (rewindButton);
    // playPauseButton.setEnabled(false);
    playPauseButton.onClick = [this]
    {
        togglePlayPause();
    };
    addAndMakeVisible(playPauseButton);
    forwardButton.setEnabled(false);
    addAndMakeVisible(forwardButton);
    beatLabel.setJustificationType(juce::Justification::centred);
    addAndMakeVisible(beatLabel);
    timeLabel.setJustificationType(juce::Justification::centredRight);
    addAndMakeVisible(timeLabel);

    // load controls

    // The 2 lines below have been commented out as test drums ID conflicts with instrument-drums

    pickJsonsCombo.addItem("ballad_vibe", 1);
    pickJsonsCombo.onChange = [this] { loadJson(); };
    addAndMakeVisible(pickJsonsCombo);
    loadJsonButton.setEnabled(false);
            
    loadJsonButton.onClick = [this]
    {
        loadEngine();
        
        
        std::string jsonStr = debugTextEditor.getText().toStdString();
        json songData = json::parse(jsonStr);
        InstrumentalGenerator::makeJsonComplete (songData);

        setWaitingForInstrumental(true);

        auto genre = juce::String(songData["genre"].get<std::string>());
        casperakiEngine->prepareEdit (genre);

        juce::Thread::launch([this, songData]() {
            json instrumentPatterns = instrumentalGenerator->loadSongInstruments(songData);
            json preparedSongData = instrumentalGenerator->getPreparedSongData(songData, instrumentPatterns);
            loadPreparedSongData(preparedSongData);
            setWaitingForInstrumental(false);
        });

        
 //       if (selectedId < 100)
 //           casperakiEngine.findInstrument (selectedId)->initTracks();
    };
            
    addAndMakeVisible (loadJsonButton);

    // debug
    debugTextEditor.setText("Begin...", false);
//    debugTextEditor.setReadOnly(true);
//    debugTextEditor.setScrollbarsShown(true);
    debugTextEditor.setMultiLine(true, false);
    debugTextEditor.setColour(juce::TextEditor::outlineColourId, juce::Colours::red);
    addAndMakeVisible(debugTextEditor);

    setWaitingForInstrumental(true);

    std::string endpointURL = "https://staging.casperaki.com";
    instrumentalGenerator = std::make_unique<InstrumentalGenerator>(
            endpointURL,
            casperakiEngine,
            [this]() {
                setWaitingForInstrumental(false);
            });
}

MainComponent::~MainComponent()
{
}

void MainComponent::loadPreparedSongData(json preparedSongData)
{
    juce::MessageManager::getInstance()->callAsync([this, preparedSongData]() {
        casperakiEngine->setSong (preparedSongData.dump ());
    });
}

//==============================================================================
void MainComponent::setWaitingForInstrumental(bool waitingForInstrumental) {
    const juce::MessageManagerLock mml (Thread::getCurrentThread());

    if (!mml.lockWasGained())
        return;

    if (waitingForInstrumental) {
        titleLabel.setText(projectName + " - Waiting for instrumental...", juce::NotificationType::dontSendNotification);
    } else {
        titleLabel.setText(projectName, juce::NotificationType::dontSendNotification);
    }

    isWaitingForInstrumental = waitingForInstrumental;
}

void MainComponent::timerCallback(CasperakiEngine::ControlState _controlState) {
//    std::cout << "timerCallback: " << _controlState.position << " " << _controlState.segment << std::endl;
    controlState = casperakiEngine->getControlState();

    // update time
    std::stringstream stream;
    stream << std::fixed << std::setprecision(1) << controlState.position << " / " << std::fixed << std::setprecision(1)
           << controlState.length;

    j::String beatText{};
    beatText << _controlState.bar + 1 << " / " <<_controlState.beat + 1;

    if (true)
    {
        const MessageManagerLock mmLock;
        timeLabel.setText(stream.str(), juce::NotificationType::dontSendNotification);

        // update start/stop
        playPauseButton.setButtonText(controlState.state == "playing" ? "||" : ">");
        beatLabel.setText(beatText, j::NotificationType::dontSendNotification);
    }
}

void MainComponent::togglePlayPause()
{
    controlState = casperakiEngine->getControlState();
    if (controlState.state == "playing")
    {
        casperakiEngine->stop();
    }
    else
    {
        casperakiEngine->play();
    }
}

void MainComponent::save()
{
    casperakiEngine->save();
}

void MainComponent::load()
{
    casperakiEngine->load();
}

void MainComponent::exportSong()
{
//    casperakiEngine->exportSongWithoutMelody ("song.wav");
    // print if is in messagethread
    DBG ("MessageManager Thread? " << (juce::MessageManager::getInstance ()->isThisTheMessageThread () ? "yes":"no"));

    auto exportedFile = casperakiEngine->exportSongWithoutMelody("song.wav");
    DBG("exportedFile: " + exportedFile.getFullPathName() + " : " +
        (exportedFile.exists() ? "exists" : "does not exist"));

}


void MainComponent::loadJson()
{

    if (pickJsonsCombo.getSelectedId() == 1)
    { // DRUMS
        j::String fileContents = BinaryData::ballad_vibe_json;
        debugTextEditor.setText(fileContents, false);
        loadJsonButton.setEnabled(true);
        return;
    }
}

void MainComponent::loadEngine()
{
    treeView.setSource (casperakiEngine->getState());
}

void MainComponent::removeInstrument (int value) {
    casperakiEngine->removeInstrument (value);
}

void MainComponent::setInstrumentVolume (int instrumentId, float db) {
    casperakiEngine->setInstrumentPostVolume (instrumentId, db);
}

void MainComponent::paint(juce::Graphics &g) {
    // (Our component is opaque, so we must completely fill the background with a solid colour)
    g.fillAll(getLookAndFeel().findColour(juce::ResizableWindow::backgroundColourId));

    g.setFont(juce::Font(16.0f));
    g.setColour(juce::Colours::white);
    // g.drawText ("Hello World!", getLocalBounds(), juce::Justification::centred, true);
}

void MainComponent::resized()
{
    auto area = getLocalBounds();

    // header
    auto headerArea = area.removeFromTop(36);
    titleLabel.setBounds(headerArea);
    saveButton.setBounds(headerArea.removeFromRight(60).reduced(5));
    exportButton.setBounds(headerArea.removeFromRight(60).reduced(5));

    // tree view
    auto treeViewArea = area.removeFromRight(area.getWidth() / 2);
    treeLabel.setBounds(treeViewArea.removeFromTop(24));
    treeView.setBounds(treeViewArea.reduced(5));

    // separator
    area.removeFromRight(10);

    // player controls
    auto playerControlsArea = area.removeFromTop(36);
    playerControlsArea.removeFromLeft(10);
    rewindButton.setBounds(playerControlsArea.removeFromLeft(46).reduced(5));
    playPauseButton.setBounds(playerControlsArea.removeFromLeft(46).reduced(5));
    forwardButton.setBounds(playerControlsArea.removeFromLeft(46).reduced(5));
    beatLabel.setBounds(playerControlsArea.removeFromRight(50));
    timeLabel.setBounds(playerControlsArea.removeFromRight(100));

    // load controls
    auto loadControlsArea = area.removeFromTop(36);
    loadJsonButton.setBounds(loadControlsArea.removeFromRight(100).reduced(5));
    pickJsonsCombo.setBounds(loadControlsArea.removeFromRight(120).reduced(5));

    // debug
    auto debugArea = area;
    debugTextEditor.setBounds(debugArea.reduced(5));

}
