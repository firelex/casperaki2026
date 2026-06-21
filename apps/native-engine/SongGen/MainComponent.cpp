#include "MainComponent.h"

#include "./utils.h"

//==============================================================================
MainComponent::MainComponent() {
    casperakiEngine = std::make_shared<CasperakiEngine>(nullptr);

    juce::LookAndFeel_V4::ColourScheme darkColourScheme = juce::LookAndFeel_V4::getDarkColourScheme();
    darkColourScheme.setUIColour(LookAndFeel_V4::ColourScheme::UIColour::windowBackground, juce::Colours::black);
    darkColourScheme.setUIColour(LookAndFeel_V4::ColourScheme::UIColour::outline, juce::Colours::darkred);

    setLookAndFeel(new juce::LookAndFeel_V4(darkColourScheme));
    setSize(500, 900);

    loadUI();
    enableUI(false);
    enablePlayer(false);

    startTimer(15);

    updateUIState(initialisingEngine);

    std::string endpointURL = "https://staging.casperaki.com";
    instrumentalGenerator = std::make_unique<InstrumentalGenerator>(
            endpointURL,
            casperakiEngine,
            [this]() {
                isEngineReady = true;
                stateCompleted(initialisingEngine);
            });
}

MainComponent::~MainComponent() {
}

void MainComponent::stateCompleted(GenerationState stateCompleted) {

    GenerationState nextState = initialisingEngine;

    switch (stateCompleted) {
        case initialisingEngine:
            DBG("Initialising engine completed");
            if (selectedGenre == none || duration < 0.25f) {
                nextState = userInput;
            } else {
                nextState = readyToGenerate;
            }
            break;
        case userInput:
            DBG("User input completed");
            if (selectedGenre != none && duration >= 1.0f) {
                nextState = readyToGenerate;
            } else {
                nextState = userInput;
            }
            break;
        default:
            // do nothing
            break;
    }
    callFunctionOnMessageThread([&] { updateUIState(nextState); });
}

void MainComponent::updateUIState(GenerationState state) {
    // check if is MessageManager thread
    DBG ("MessageManager Thread? " << (juce::MessageManager::getInstance()->isThisTheMessageThread() ? "Yes" : "No"));
    // update the UI according to the current state
    switch (state) {
        case initialisingEngine:
            statusLabel.setText("Initialising engine...", juce::NotificationType::dontSendNotification);
            enableUI(true);
            enablePlayer(false);
            break;
        case userInput:
            if (selectedGenre == none) {
                statusLabel.setText("Please select a genre...", juce::NotificationType::dontSendNotification);
            } else if (duration < 1.0f) {
                statusLabel.setText("Please select a duration bigger than 15 seconds...",
                                    juce::NotificationType::dontSendNotification);
            }
            enableUI(true);
            generateButton.setEnabled(false);
            break;
        case readyToGenerate:
            statusLabel.setText("Ready to generate!", juce::NotificationType::dontSendNotification);
            enableUI(true);
            generateButton.setEnabled(true);
            break;
        case generatingVibe:
            statusLabel.setText("Generating vibe details...", juce::NotificationType::dontSendNotification);
            enableUI(false);
            enablePlayer(false);
            break;
        case generatingSong:
            statusLabel.setText("Generating song details...", juce::NotificationType::dontSendNotification);
            enableUI(false);
            enablePlayer(false);
            break;
        case creatingSong:
            statusLabel.setText("Creating song...", juce::NotificationType::dontSendNotification);
            enableUI(false);
            enablePlayer(false);
            break;
        case finishedCreatingSong:
            statusLabel.setText("Finished creating your song!", juce::NotificationType::dontSendNotification);
            enableUI(true);
            enablePlayer(true);
            generateButton.setButtonText("Generate another song!");
            setupPlayer();
            break;
        case renderingSong:
            statusLabel.setText("Rendering song...", juce::NotificationType::sendNotification);
            enableUI(false);
            break;
        case finishedRenderingSong:
            statusLabel.setText("Finished rendering song!", juce::NotificationType::dontSendNotification);
            enableUI(true);
            enablePlayer(true);
            break;
        case error:
            statusLabel.setText("Error!", juce::NotificationType::dontSendNotification);
            enableUI(true);
            enablePlayer(false);
            break;
    }
}

void MainComponent::generateSong() {
    // check if is MessageManager thread
    DBG ("MessageManager Thread? " << (juce::MessageManager::getInstance()->isThisTheMessageThread() ? "Yes" : "No"));

    // generate vibe json
    callFunctionOnMessageThread([&] { updateUIState(generatingVibe); });
    vibeJson = instrumentalGenerator->generateVibeJSON(getGenreApiName(selectedGenre), 2);
    DBG("VIBE!: " << vibeJson.dump(2));

    // generate song json
    callFunctionOnMessageThread([&] { updateUIState(generatingSong); });
    songJson = instrumentalGenerator->performGetArrangement(
            "getArrangementFull?reduce=" + String{duration, 2}, vibeJson);
    DBG("Song!: " << songJson.dump(2));

    // create song
    callFunctionOnMessageThread([&] { updateUIState(creatingSong); });
    InstrumentalGenerator::makeJsonComplete(songJson);

    callFunctionOnMessageThread([&] {
        auto genre = juce::String(songJson["genre"].get<std::string>());
        isEngineReady = false;
        casperakiEngine->prepareEdit(genre);
        isEngineReady = true;
        statusLabel.setText("Loading instruments...", juce::NotificationType::dontSendNotification);
    });

    instrumentalGenerator->preDownloadInstrumentSamples (songJson);
    json instrumentPatterns = instrumentalGenerator->loadSongInstruments(songJson);
    json preparedSongData = instrumentalGenerator->getPreparedSongData(songJson, instrumentPatterns);

    callFunctionOnMessageThread([&] {
        updateUIState(creatingSong);
        casperakiEngine->setSong(preparedSongData.dump());
        updateUIState(finishedCreatingSong);
    });

//    callFunctionOnMessageThread([&] {
//        updateUIState(renderingSong);
//    });

    return;

//     MessageManager::getInstance()->callFunctionOnMessageThread (MainComponent::startExportSong, (void*) this);

    struct RenderCallback : public CallbackMessage {
        RenderCallback(MainComponent &o) : owner(o) {}

        void messageCallback() override {
            owner.exportSong();
            owner.updateUIState(finishedRenderingSong);
        }

        MainComponent &owner;
    };

    (new RenderCallback(*this))->post();


    // render song
    DBG ("renderSong MessageManager Thread? "
                 << (juce::MessageManager::getInstance()->isThisTheMessageThread() ? "yes" : "no"));


}

void *MainComponent::startExportSong(void *mainComponentPtr) {
    static_cast<MainComponent *> (mainComponentPtr)->exportSong();
    return nullptr;
}

void MainComponent::exportSong() {
    songFile = casperakiEngine->exportSongWithoutMelody(
            "Casperaki_" + getGenreString(selectedGenre) + "_" + minutesInput.getText() + "_" +
            secondsInput.getText());
    DBG("exportedFile: " + songFile.getFullPathName() + " : " +
        (songFile.exists() ? "exists" : "does not exist"));
}


void MainComponent::enableUI(bool enable) {
    minutesInput.setEnabled(enable);
    secondsInput.setEnabled(enable);
    balladButton.setEnabled(enable);
    brightPopButton.setEnabled(enable);
    danceButton.setEnabled(enable);
    latinButton.setEnabled(enable);
    organicVibesButton.setEnabled(enable);
    rnbButton.setEnabled(enable);
    rockButton.setEnabled(enable);
    schlagerButton.setEnabled(enable);
    generateButton.setEnabled(enable);
}

void MainComponent::enablePlayer(bool enable) {
    // if (!songFile.exists()) enable = false;

    playButton.setVisible(enable);
    stopButton.setVisible(enable);
    currentPositionLabel.setVisible(enable);
    saveButton.setVisible(enable);
}

void MainComponent::setupPlayer() {
    playButton.setEnabled(false);
    stopButton.setEnabled(false);

    currentPositionLabel.setText("Stopped", juce::NotificationType::dontSendNotification);
    auto &transportSource = casperakiEngine->getEdit()->getTransport();
    transportSource.addChangeListener(this);
    playButton.setEnabled(true);
}

//==============================================================================
// Player stuff

void MainComponent::changeListenerCallback(juce::ChangeBroadcaster *source) {
    if (!casperakiEngine->getEdit())
        return;

    auto &transport = casperakiEngine->getEdit()->getTransport();

    playButton.setButtonText(transport.isPlaying() ? "Pause" : "Play");
    stopButton.setEnabled(true);
}

void MainComponent::timerCallback() {
    if (!isEngineReady) return;

    auto &transport = casperakiEngine->getEdit()->getTransport();
    juce::RelativeTime position(transport.getCurrentPosition());
    if (transport.isPlaying()) {
        auto minutes = ((int) position.inMinutes()) % 60;
        auto seconds = ((int) position.inSeconds()) % 60;
        auto millis = ((int) position.inMilliseconds()) % 1000;

        auto positionString = juce::String::formatted("%02d:%02d:%03d", minutes, seconds, millis);

        currentPositionLabel.setText(positionString, juce::dontSendNotification);
    } else if (position.inSeconds() == 0.0) {
        currentPositionLabel.setText("Stopped", juce::dontSendNotification);
    }
}


//==============================================================================

void MainComponent::save() {
    casperakiEngine->save();
}

void MainComponent::loadEngine() {

}

void MainComponent::paint(juce::Graphics &g) {
    // (Our component is opaque, so we must completely fill the background with a solid colour)
    g.fillAll(getLookAndFeel().findColour(juce::ResizableWindow::backgroundColourId));
//
//    g.setFont(juce::Font(16.0f));
//    g.setColour(juce::Colours::white);
    // g.drawText ("Hello World!", getLocalBounds(), juce::Justification::centred, true);
}

void MainComponent::resized() {
    auto area = getLocalBounds();
    // header
    auto headerArea = area.removeFromTop(100);
    titleLabel.setBounds(headerArea);

    // duration picker
    auto durationArea = area.removeFromTop(70).withWidth(200).withX(area.getWidth() / 2 - 100);
    durationTitleLabel.setBounds(durationArea.removeFromTop(20));
    durationArea.removeFromLeft (30);
    minutesInput.setBounds(durationArea.removeFromLeft(60).reduced(0, 10));
    dividerLabel.setBounds(durationArea.removeFromLeft(20));
    secondsInput.setBounds(durationArea.removeFromLeft(60).reduced(0, 10));

    // genre picker
    area.removeFromTop(40); // spacer
    auto genreArea = area.removeFromTop(220).withWidth(400).withX(area.getWidth() / 2 - 200);
    genreTitleLabel.setBounds(genreArea.removeFromTop(20));
    auto genreButtonsRow1 = genreArea.removeFromTop(100);
    auto genreButtonSize = genreButtonsRow1.getWidth() / 4; // 4 buttons per row, 2 rows
    balladButton.setBounds(genreButtonsRow1.removeFromLeft(genreButtonSize).reduced(10, 10));
    balladLabel.setBounds(balladButton.getBounds().removeFromBottom(20));
    brightPopButton.setBounds(genreButtonsRow1.removeFromLeft(genreButtonSize).reduced(10, 10));
    brightPopLabel.setBounds(brightPopButton.getBounds().removeFromBottom(20));
    danceButton.setBounds(genreButtonsRow1.removeFromLeft(genreButtonSize).reduced(10, 10));
    danceLabel.setBounds(danceButton.getBounds().removeFromBottom(20));
    latinButton.setBounds(genreButtonsRow1.removeFromLeft(genreButtonSize).reduced(10, 10));
    latinLabel.setBounds(latinButton.getBounds().removeFromBottom(20));
    auto genreButtonsRow2 = genreArea.removeFromTop(100);
    organicVibesButton.setBounds(genreButtonsRow2.removeFromLeft(genreButtonSize).reduced(10, 10));
    organicVibesLabel.setBounds(organicVibesButton.getBounds().removeFromBottom(20));
    rnbButton.setBounds(genreButtonsRow2.removeFromLeft(genreButtonSize).reduced(10, 10));
    rnbLabel.setBounds(rnbButton.getBounds().removeFromBottom(20));
    rockButton.setBounds(genreButtonsRow2.removeFromLeft(genreButtonSize).reduced(10, 10));
    rockLabel.setBounds(rockButton.getBounds().removeFromBottom(20));
    schlagerButton.setBounds(genreButtonsRow2.removeFromLeft(genreButtonSize).reduced(10, 10));
    schlagerLabel.setBounds(schlagerButton.getBounds().removeFromBottom(20));

    // status
    area.removeFromTop(40); // spacer
    statusLabel.setBounds(area.removeFromTop(40).reduced(50, 0));

    // generate button
    area.removeFromTop(20); // spacer
    generateButton.setBounds(area.removeFromTop(40).withWidth(200).withX(area.getWidth() / 2 - 100));

    // player
    area.removeFromTop(40); // spacer
    auto playerArea = area.removeFromTop(60).withWidth(400).withX(area.getWidth() / 2 - 200);
    playButton.setBounds(playerArea.removeFromLeft(100).reduced(10, 10));
    stopButton.setBounds(playerArea.removeFromLeft(100).reduced(10, 10));
    currentPositionLabel.setBounds(playerArea.removeFromLeft(100).reduced(0, 10));
    saveButton.setBounds(playerArea.removeFromLeft(100).reduced(10, 10));

}

void
MainComponent::setGenreButton(juce::ImageButton &button, juce::String genreName, const char *imageData, int imageSize,
                              juce::Label &buttonLabel) {
    button.setButtonText(genreName);
    button.setImages(false, true, true,
                     juce::ImageCache::getFromMemory(imageData, imageSize),
                     0.7f, juce::Colours::transparentBlack,
                     juce::ImageCache::getFromMemory(imageData, imageSize),
                     1.0f, juce::Colours::transparentBlack,
                     juce::ImageCache::getFromMemory(imageData, imageSize),
                     1.0f, juce::Colours::transparentWhite.withAlpha(0.2f),
                     0.5f);
    button.setToggleable(true);
    button.setRadioGroupId(1);
    button.setClickingTogglesState(true);
    button.onStateChange = [this, genreName, &button] {
        if (button.getToggleState()) {
            DBG("Genre selected: " << genreName);
            selectedGenre = getGenreFromName(genreName);
            stateCompleted(userInput);
            auto buttonCenter = button.getPosition().translated(button.getWidth() / 2, button.getHeight() / 2);
            button.setTransform(AffineTransform::scale(1.2f, 1.2f, buttonCenter.x, buttonCenter.y));
        } else {
            button.setTransform(AffineTransform::scale(1.0f, 1.0f));
        }
    };

    buttonLabel.setText(genreName, juce::NotificationType::dontSendNotification);
    buttonLabel.setColour(juce::Label::ColourIds::textColourId, juce::Colours::white);
    buttonLabel.setFont(juce::Font(juce::Font::getDefaultMonospacedFontName(), 12.0f, juce::Font::bold));
    buttonLabel.setJustificationType(juce::Justification::centred);
    buttonLabel.setInterceptsMouseClicks(false, false);

    addAndMakeVisible(button);
    addAndMakeVisible(buttonLabel);
}

void MainComponent::loadUI() {
    // header
    titleLabel.setText(juce::String("Casperaki Demo App").toUpperCase(),
                       juce::NotificationType::dontSendNotification);
    titleLabel.setColour(juce::Label::ColourIds::textColourId, juce::Colours::white);
    titleLabel.setFont(juce::Font(24.0f));
    titleLabel.setJustificationType(juce::Justification::centred);
    addAndMakeVisible(titleLabel);

    // duration picker
    durationTitleLabel.setColour(juce::Label::ColourIds::textColourId, juce::Colours::white);
    durationTitleLabel.setFont(juce::Font(16.0f));
    durationTitleLabel.setJustificationType(juce::Justification::centred);
    addAndMakeVisible(durationTitleLabel);
    minutesInput.setEditable(true);
    minutesInput.setKeyboardType(TextInputTarget::VirtualKeyboardType::numericKeyboard);
    minutesInput.setColour(juce::Label::ColourIds::textColourId, juce::Colours::white);
    minutesInput.setColour(Label::ColourIds::backgroundColourId, Colours::darkgrey);
    minutesInput.setFont(juce::Font(juce::Font::getDefaultMonospacedFontName(), 20.0f, 0));
    minutesInput.setJustificationType(Justification::centred);
    minutesInput.onTextChange = [this] {
        auto text = minutesInput.getText();
        int64 intValue = text.getIntValue();
        intValue = Range<int64>(0, 5).clipValue(intValue);
        minutesInput.setText(juce::String(intValue), dontSendNotification);
        duration = minutesInput.getText().getFloatValue() + secondsInput.getText().getFloatValue() / 60.0f;
        stateCompleted(userInput);
    };
    addAndMakeVisible(minutesInput);
    dividerLabel.setColour(juce::Label::ColourIds::textColourId, juce::Colours::white);
    dividerLabel.setFont(juce::Font(24.0f));
    dividerLabel.setJustificationType(juce::Justification::centred);
    addAndMakeVisible(dividerLabel);
    secondsInput.setEditable(true);
    secondsInput.setKeyboardType(TextInputTarget::VirtualKeyboardType::numericKeyboard);
    secondsInput.setColour(juce::Label::ColourIds::textColourId, juce::Colours::white);
    secondsInput.setColour(Label::ColourIds::backgroundColourId, Colours::darkgrey);
    secondsInput.setFont(juce::Font(juce::Font::getDefaultMonospacedFontName(), 20.0f, 0));
    secondsInput.setJustificationType(Justification::centred);
    // make sure the text edit is a numeric value
    secondsInput.onTextChange = [this] {
        auto text = secondsInput.getText();
        int64 intValue = text.getIntValue();
        intValue = Range<int64>(0, 59).clipValue(intValue);
        secondsInput.setText(juce::String(intValue).paddedLeft('0', 2), dontSendNotification);
        duration = minutesInput.getText().getFloatValue() + secondsInput.getText().getFloatValue() / 60.0f;
        stateCompleted(userInput);
    };
    addAndMakeVisible(secondsInput);

    // genre picker
    genreTitleLabel.setColour(juce::Label::ColourIds::textColourId, juce::Colours::white);
    genreTitleLabel.setFont(juce::Font(16.0f));
    addAndMakeVisible(genreTitleLabel);
    setGenreButton(balladButton, "Ballad", BinaryData::genreballad_png, BinaryData::genreballad_pngSize, balladLabel);
    setGenreButton(brightPopButton, "Bright Pop", BinaryData::genrebrightpop_png, BinaryData::genrebrightpop_pngSize,
                   brightPopLabel);
    setGenreButton(danceButton, "Dance", BinaryData::genredance_png, BinaryData::genredance_pngSize, danceLabel);
    setGenreButton(latinButton, "Latin", BinaryData::genrelatin_png, BinaryData::genrelatin_pngSize, latinLabel);
    setGenreButton(organicVibesButton, "Organic Vibes", BinaryData::genreorganicvibes_png,
                   BinaryData::genreorganicvibes_pngSize, organicVibesLabel);
    setGenreButton(rnbButton, "R&B", BinaryData::genrernb_png, BinaryData::genrernb_pngSize, rnbLabel);
    setGenreButton(rockButton, "Rock", BinaryData::genrerock_png, BinaryData::genrerock_pngSize, rockLabel);
    setGenreButton(schlagerButton, "Schlager", BinaryData::genreschlager_png, BinaryData::genreschlager_pngSize,
                   schlagerLabel);

    // status
    statusLabel.setColour(juce::Label::ColourIds::textColourId, juce::Colours::white);
    statusLabel.setFont(juce::Font(juce::Font::getDefaultSansSerifFontName(), 16.0f, juce::Font::italic));
    statusLabel.setJustificationType(juce::Justification::centred);
    addAndMakeVisible(statusLabel);

    // generate button
    generateButton.setColour(TextButton::ColourIds::buttonColourId, Colours::darkred);
    generateButton.setColour(TextButton::ColourIds::textColourOnId, Colours::white);
    generateButton.setButtonText("Generate!");
    generateButton.onClick = [this] {
        juce::Thread::launch([this] {
            generateSong();
        });
    };
    addAndMakeVisible(generateButton);

    // player
    playButton.setButtonText("Play");
    playButton.onClick = [this] {
        auto &transport = casperakiEngine->getEdit()->getTransport();
        if (transport.isPlaying())
            casperakiEngine->pause();
        else
            casperakiEngine->play();
    };
    playButton.setColour(juce::TextButton::buttonColourId, juce::Colours::green);
    addAndMakeVisible(&playButton);

    stopButton.setButtonText("Stop");
    stopButton.onClick = [this] {
        casperakiEngine->stop();
    };
    stopButton.setColour(juce::TextButton::buttonColourId, juce::Colours::red);
    addAndMakeVisible(&stopButton);

    currentPositionLabel.setColour(juce::Label::ColourIds::textColourId, juce::Colours::white);
    currentPositionLabel.setFont(juce::Font(juce::Font::getDefaultMonospacedFontName(), 16.0f, 0));
    currentPositionLabel.setText("Stopped", juce::dontSendNotification);
    addAndMakeVisible(&currentPositionLabel);

    saveButton.setButtonText("Export and Save");
    saveButton.onClick = [this] {
        juce::Thread::launch([this] {

            if (!songFile.exists()) {

                // render song to file
                callFunctionOnMessageThread([&] { updateUIState(renderingSong); });
                // allow the UI to update
                juce::Thread::sleep(100);
                callFunctionOnMessageThread([&] { exportSong(); });
                callFunctionOnMessageThread([&] { updateUIState(finishedRenderingSong); });
            }
            fileChooser = std::make_unique<FileChooser>("Save your song " + songFile.getFileName(),
                                                        songFile,
                                                        "*.wav");

            auto folderChooserFlags = juce::FileBrowserComponent::saveMode
                                      | juce::FileBrowserComponent::warnAboutOverwriting;

            fileChooser->launchAsync(folderChooserFlags, [this](const FileChooser &chooser) {
                auto url = chooser.getURLResult();

#if JUCE_ANDROID
                auto androidDocument = AndroidDocument::fromDocument(url);
                auto outputStream = androidDocument.createOutputStream();
#elif !JUCE_IOS
                auto outputStream = url.getLocalFile().createOutputStream();
#else
                auto outputStream = url.createOutputStream();
#endif

                FileInputStream fileInputStream(songFile);
                outputStream->writeFromInputStream(fileInputStream, -1);
            });
        });
    };
    saveButton.setColour(juce::TextButton::buttonColourId, juce::Colours::darkred);
    addAndMakeVisible(&saveButton);
}
