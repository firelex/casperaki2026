#pragma once

#include <JuceHeader.h>

#include "../Source/InstrumentalGenerator.h"
#include <future>

//==============================================================================
/*
    This component lives inside our window, and this is where you should put all
    your controls and content.
*/
class MainComponent : public juce::Component,
                      public juce::ChangeListener,
                      public juce::Timer {
 public:
  //==============================================================================
  MainComponent ();

  ~MainComponent () override;

  //==============================================================================
  void paint (juce::Graphics &) override;

  void resized () override;

 private:
  enum Genre {
      none = -1,
      ballad,
      brightPop,
      dance,
      latin,
      organicVibes,
      rnb,
      rock,
      schlager
  };

  enum GenerationState {
      initialisingEngine,
      userInput,
      readyToGenerate,
      generatingVibe,
      generatingSong,
      creatingSong,
      finishedCreatingSong,
      renderingSong,
      finishedRenderingSong,
      error
  };

  float duration = 1.50f;
  Genre selectedGenre = none;

  json vibeJson, songJson;

  File songFile;

  template<typename Function>
  void callFunctionOnMessageThread (Function&& func)
  {
      if (MessageManager::getInstance()->isThisTheMessageThread())
      {
          func();
      }
      else
      {
          jassert (! MessageManager::getInstance()->currentThreadHasLockedMessageManager());
          WaitableEvent finishedSignal;
          MessageManager::callAsync ([&]
                                     {
                                         func();
                                         finishedSignal.signal();
                                     });
          finishedSignal.wait (-1);
      }
  }

  void stateCompleted (GenerationState stateCompleted);
  void updateUIState (GenerationState state);

  void enableUI (bool enable);
  void enablePlayer(bool enable);
  // void generateVibe ();
  void generateSong ();
  static void* startExportSong (void* mainComponentPtr);
  void exportSong();
  // void createSong ();
  // void renderSong ();
  void setupPlayer ();

  //==============================================================================

  // Player stuff
  void changeListenerCallback (juce::ChangeBroadcaster* source) override;
  void timerCallback() override;

  std::unique_ptr<juce::FileChooser> chooser;

  // Your private member variables go here...
  bool isEngineReady = false;

  // header components
  juce::Label titleLabel;

  // duration picker components
  juce::Label durationTitleLabel{"durationLabel", "Choose the song duration"};
  juce::Label minutesInput{"minutes", "3"};
  juce::Label dividerLabel{"minutesDivider", ":"};
  juce::Label secondsInput{"seconds", "00"};

  // genre picker components
  juce::Label genreTitleLabel{"genreLabel", "Choose the song genre"};
  juce::ImageButton balladButton{"balladButton"};
  juce::Label balladLabel{"balladLabel", "Ballad"};
  juce::ImageButton brightPopButton{"brightPopButton"};
  juce::Label brightPopLabel{"brightPopLabel", "Bright Pop"};
  juce::ImageButton danceButton{"danceButton"};
  juce::Label danceLabel{"danceLabel", "Dance"};
  juce::ImageButton latinButton{"latinButton"};
  juce::Label latinLabel{"latinLabel", "Latin"};
  juce::ImageButton organicVibesButton{"organicVibesButton"};
  juce::Label organicVibesLabel{"organicVibesLabel", "Organic Vibes"};
  juce::ImageButton rnbButton{"rnbButton"};
  juce::Label rnbLabel{"rnbLabel", "R&B"};
  juce::ImageButton rockButton{"rockButton"};
  juce::Label rockLabel{"rockLabel", "Rock"};
  juce::ImageButton schlagerButton{"schlagerButton"};
  juce::Label schlagerLabel{"schlagerLabel", "Schlager"};

  // status components
  juce::Label statusLabel{"statusLabel", "Initialising engine..."};
  juce::TextButton generateButton{"generateButton", "Generate!"};

  // player components
  juce::TextButton playButton;
  juce::TextButton stopButton;
  juce::Label currentPositionLabel;
  juce::TextButton saveButton;
  std::unique_ptr<juce::FileChooser> fileChooser;

  CasperakiEngine::ControlState controlState;
  std::shared_ptr<CasperakiEngine> casperakiEngine;
  std::unique_ptr<InstrumentalGenerator> instrumentalGenerator;

  void
  setGenreButton (juce::ImageButton &button, juce::String genreName, const char *imageData, int imageSize, juce::Label &buttonLabel);

  void loadUI ();

  void save ();

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainComponent)

  void loadEngine ();

  Genre getGenreFromName (juce::String genreName)
  {
      if (genreName == "Ballad")
      {
          return ballad;
      }
      else if (genreName == "Bright Pop")
      {
          return brightPop;
      }
      else if (genreName == "Dance")
      {
          return dance;
      }
      else if (genreName == "Latin")
      {
          return latin;
      }
      else if (genreName == "Organic Vibes")
      {
          return organicVibes;
      }
      else if (genreName == "R&B")
      {
          return rnb;
      }
      else if (genreName == "Rock")
      {
          return rock;
      }
      else if (genreName == "Schlager")
      {
          return schlager;
      }
      else
      {
          return ballad;
      }
  }

  String getGenreApiName (Genre genre)
  {
      switch (genre)
      {
          case ballad:
              return "ballad";
          case brightPop:
              return "brightPop";
          case dance:
              return "edm";
          case latin:
              return "latin";
          case organicVibes:
              return "organicVibes";
          case rnb:
              return "urban";
          case rock:
              return "rock";
          case schlager:
              return "schlager";
          default:
              return "ballad";
      }
  }

  String getGenreString (Genre genre)
  {
      switch (genre)
      {
          case dance:
              return "dance";
          case rnb:
              return "rnb";
          default:
              return getGenreApiName (genre);
      }
  }
};

