/*
  ==============================================================================

    InstrumentalGenerator.h
    Created: 23 Mar 2023 2:53:46pm
    Author:  Abhishek Shivakumar

  ==============================================================================
*/

#pragma once
#include "CasperakiEngine.h"
#include "./CasperakiApi.h"
#include <chrono>

//TODO: Fix this ugly long include
//Include matchering here
#include "../dependencies/matchering/Source/Matchering.h"
#include "./MetaDatabase.h"
#include "./AudioTools.h"
#include "SamplesBulkDownloadTask.h"

class InstrumentalGenerator {
  std::shared_ptr<CasperakiEngine> casperakiEngine;
  std::unique_ptr<CasperakiApi> casperakiApi;
  std::unique_ptr<MetaDatabase> metaDatabase;

  juce::String jsonString;
  json currentSongJson;
  json config;

  juce::String getJSONFromPath (juce::String filePath)
  {
      auto fileToLoad = File::getCurrentWorkingDirectory ().getChildFile (filePath);
      DBG(fileToLoad.getFullPathName ());

      if (!fileToLoad.exists ())
      {
          DBG ("JSON File: " + filePath + " does not exist");
          return {};
      }

      juce::FileInputStream fis (fileToLoad);
      if (!fis.openedOk ())
      {
          DBG ("JSON File: " + filePath + " could not be opened");
          return {};
      }

      juce::String fileContents = fis.readEntireStreamAsString ();
      return fileContents;
  }

  juce::File saveAndExportSong (juce::String filePath, bool shouldRenderMelody, bool shouldMaster = false, bool isVibe = false)
  {
      casperakiEngine->save ();
      juce::File exportedFile;
      if (shouldRenderMelody)
      {
          exportedFile = casperakiEngine->exportSongWithMelody (filePath);
      }
      else
      {
          exportedFile = casperakiEngine->exportSongWithoutMelody (filePath);
      }

      juce::String fileName = exportedFile.getFileNameWithoutExtension();

      double exportedSampleRate = getSampleRate (exportedFile.getFullPathName ());
      juce::String separator = juce::File::getSeparatorString ();
      juce::AudioBuffer<float> exportBuffer;
      exportBuffer.makeCopyOf (Matchering::readAudioFromFile (exportedFile.getFullPathName ()));

      if (exportedSampleRate != 44100.0)
      {
          juce::Logger::writeToLog ("Audio device has major issues. It is locked to: " + juce::String (exportedSampleRate) + ". Probably due to a wonky driver. \n");
          juce::Logger::writeToLog ("We will resample the audio back to 44100 ourselves. \n");
          resampleAudioBuffer (exportBuffer, exportedSampleRate, 44100);
      }

      juce::Logger::writeToLog ("Rendering song.");

      exportedFile = exportFileToWAV (exportBuffer, exportedFile.getParentDirectory ().getFullPathName () + separator + fileName + "_unmastered.wav", 44100);

      if (shouldMaster)
      {
          auto start = std::chrono::high_resolution_clock::now ();
          masterSongAtemlos (exportedFile.getFullPathName (), exportedFile.getParentDirectory ().getFullPathName (), true, true, 44100, isVibe);
          auto stop = std::chrono::high_resolution_clock::now ();
          auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(stop - start);
          std::cout << "Time taken to Master Song: " << duration.count () << " milliseconds" << std::endl;
          DeferredLogger& logger = DeferredLogger::getInstance ();
          logger.logMessage ("Time taken to Master Song: " + juce::String (duration.count ()) + " milliseconds");
      }

      return exportedFile;
  }


  juce::File saveAndExportMelody (juce::String filePath, bool shouldMaster = false, bool isVibe = false)
  {
      std::cout << "Saving and exporting melody" << std::endl;
      casperakiEngine->save ();

      auto exportedMelodyFile = casperakiEngine->exportVocalMelody (filePath);

      double exportedSampleRate = getSampleRate (exportedMelodyFile.getFullPathName ());
      juce::String separator = juce::File::getSeparatorString ();
      juce::AudioBuffer<float> exportBuffer, exportedMelodyBuffer;
      exportedMelodyBuffer.makeCopyOf (Matchering::readAudioFromFile (exportedMelodyFile.getFullPathName()));

      if (exportedSampleRate != 44100.0)
      {
          juce::Logger::writeToLog ("Audio device has major issues. It is locked to: " + juce::String (exportedSampleRate) + ". Probably due to a wonky driver. \n");
          juce::Logger::writeToLog ("We will resample the audio back to 44100 ourselves. \n");
          resampleAudioBuffer (exportedMelodyBuffer, exportedSampleRate, 44100);
      }

      juce::Logger::writeToLog ("Rendering vocals.");
      exportedMelodyFile = exportFileToWAV (exportedMelodyBuffer, exportedMelodyFile.getParentDirectory().getFullPathName() + separator + exportedMelodyFile.getFileName(), 44100);

      juce::String fileName = exportedMelodyFile.getFileNameWithoutExtension ();


      //TODO: Make this state based and not a function parameter
      if (shouldMaster)
      {

          auto start = std::chrono::high_resolution_clock::now ();

          masterSongAtemlos (exportedMelodyFile.getFullPathName (), exportedMelodyFile.getParentDirectory ().getFullPathName (), true, true, 44100, isVibe);

          auto stop = std::chrono::high_resolution_clock::now ();
          auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(stop - start);

          std::cout << "Time taken to Master Song: " << duration.count () << " milliseconds" << std::endl;

          DeferredLogger& logger = DeferredLogger::getInstance ();
          logger.logMessage ("Time taken to Master Song: " + juce::String (duration.count ()) + " milliseconds");
      }

      return exportedMelodyFile;
  }

 public:

  static void makeJsonComplete(json &jsonObj)
  {
      if (!jsonObj.contains ("structure") || !jsonObj["structure"].is_array ()) jsonObj["structure"] = json::array ();
      if (jsonObj["structure"].empty ()) jsonObj["structure"].push_back ({ {"segment", "default"} });
      if (jsonObj.contains ("songStructure")) { jsonObj["structure"] = jsonObj["songStructure"]; }
      if (!jsonObj.contains ("arrangement")) jsonObj["arrangement"] = {};
  }

  bool hasGeneratedInstrumental ()
  {
      return casperakiEngine->getLastGenerationSuccessful ();
  }

  InstrumentalGenerator (juce::String endpointURL)
  {
      //base URL must be set before initalizing the engine
      setBaseURL (endpointURL);

      casperakiApi = std::make_unique<CasperakiApi> (juce::URL (endpointURL));
      casperakiEngine.reset (new CasperakiEngine (nullptr));

      metaDatabase = std::make_unique<MetaDatabase> ();

      //login and load config from API
      //casperakiApi->login();
      loadConfigFromApi ();
  }

  InstrumentalGenerator (
            juce::String endpointURL,
            std::shared_ptr<CasperakiEngine> casperakiEngine,
            std::function<void()> callback)
    {
        //base URL must be set before initalizing the engine
        setBaseURL (endpointURL);

        this->casperakiEngine = casperakiEngine;
        casperakiApi = std::make_unique<CasperakiApi> (juce::URL (endpointURL));

        metaDatabase = std::make_unique<MetaDatabase> ();

        //login and load config from API
        //casperakiApi->login();
        juce::Thread::launch ([this, callback] {
            loadConfigFromApi ();
            callback();
        });
    }

  void generateInstrumentalFromJSON (juce::String jsonDataString, bool shouldGenerateMelody, bool shouldMaster = false)
  {
      std::string stdString = jsonDataString.toStdString ();
      nlohmann::json jsonObj = nlohmann::json::parse (stdString);
      std::cout << "Parsed JSON object" << std::endl;
      generateInstrumentalFromJSON (jsonObj, shouldGenerateMelody, shouldMaster);
  }

  juce::File generateMelodyFromJSON (juce::String jsonFilePath, bool shouldMaster = false)
  {
      std::string stdString = juce::File(jsonFilePath).loadFileAsString ().toStdString();
      
      nlohmann::json jsonObj = nlohmann::json::parse (stdString);
      std::cout << "Parsed JSON object" << std::endl;
      return generateMelodyFromJSON (jsonObj, shouldMaster);
  }

  void generateInstrumentalFromJSONFile (juce::File file, bool shouldGenerateMelody = false, bool shouldMaster = false)
  {
      juce::String JSONString = getJSONFromPath (file.getFullPathName ());
      std::string stdString = JSONString.toStdString ();
      nlohmann::json jsonObj = nlohmann::json::parse (stdString);
      generateInstrumentalFromJSON (jsonObj, shouldGenerateMelody, shouldMaster);
  }

  juce::File generateMelodyFromJSON (json jsonObj, bool shouldMaster = false)
  {
      juce::String genreName (jsonObj["genre"].dump ());
      genreName = genreName.unquoted ();
      DBG ("The json prior to transformation is: " + jsonObj.dump());
      bool isSong = false;
      try { casperakiEngine->prepareEdit (genreName); }
      catch (const std::exception& e) { std::cerr << "Error occurred while preparing edit: " << e.what () << std::endl; }

      if (!jsonObj.contains ("state")) jsonObj["state"] = "unloaded";
      if (!jsonObj.contains ("structure") || !jsonObj["structure"].is_array ()) jsonObj["structure"] = json::array ();
      if (jsonObj["structure"].empty ()) jsonObj["structure"].push_back ({ {"segment", "default"} });
      if (jsonObj.contains ("songStructure")) { jsonObj["structure"] = jsonObj["songStructure"]; isSong = true; }
      if (!jsonObj.contains ("arrangement")) jsonObj["arrangement"] = "";

      if (!jsonObj.contains ("tempo"))
      {
          if (jsonObj.contains ("patterns") && jsonObj["patterns"].is_array () && !jsonObj["patterns"].empty ())
          {
              jsonObj["tempo"] = jsonObj["patterns"][0]["bpm"];
          }
          else
          {
              // Handle the case when "patterns" or "bpm" is missing
              // You can set a default value or handle the error as needed
              std::cerr << "BPM is missing" << std::endl;
          }
      }

      try
      {
        loadSongData (jsonObj);
      }
      catch (const std::exception &e)
      {
        std::cerr << "Error occurred while loading song data: " << e.what () << std::endl;
        throw;
      }

      //Save and export. If shouldMaster is true, master the song
      try
      {
          juce::String title = jsonObj["title"].dump();
          if (title.isQuotedString())
          {
              title = title.unquoted ();
          }

          bool isVibe = false;
          if (jsonObj["songStructure"] == nullptr)
          {
              isVibe = true;
          }

          juce::File exportedFile = saveAndExportMelody (title, shouldMaster, isVibe);
          return exportedFile;
      }
      catch (const std::exception &e)
      {
          std::cerr << "Error occurred while saving and exporting: " << e.what () << std::endl;
      }

      // Reached only when saving/exporting threw — return an invalid file rather
      // than falling off the end of this non-void function (which is UB).
      return {};
  }

  void generateInstrumentalFromJSON (json jsonObj, bool shouldGenerateMelody, bool shouldMaster = false)
  {
      juce::String genreName (jsonObj["genre"].dump ());
      genreName = genreName.unquoted ();
      DBG ("The json prior to transformation is: " + jsonObj.dump());
      bool isSong = false;
      try { casperakiEngine->prepareEdit (genreName); }
      catch (const std::exception& e) { std::cerr << "Error occurred while preparing edit: " << e.what () << std::endl; }

      if (!jsonObj.contains ("state")) jsonObj["state"] = "unloaded";
      if (!jsonObj.contains ("structure") || !jsonObj["structure"].is_array ()) jsonObj["structure"] = json::array ();
      if (jsonObj["structure"].empty ()) jsonObj["structure"].push_back ({ {"segment", "default"} });
      if (jsonObj.contains ("songStructure")) { jsonObj["structure"] = jsonObj["songStructure"]; isSong = true; }
      if (!jsonObj.contains ("arrangement")) jsonObj["arrangement"] = "";

      if (!jsonObj.contains ("tempo"))
      {
          if (jsonObj.contains ("patterns") && jsonObj["patterns"].is_array () && !jsonObj["patterns"].empty ())
          {
              jsonObj["tempo"] = jsonObj["patterns"][0]["bpm"];
          }
          else
          {
              // Handle the case when "patterns" or "bpm" is missing
              // You can set a default value or handle the error as needed
              std::cerr << "BPM is missing" << std::endl;
          }
      }

      try
      {
        loadSongData (jsonObj);
      }
      catch (const std::exception &e)
      {
        std::cerr << "Error occurred while loading song data: " << e.what () << std::endl;
        throw;
      }

      //Save and export. If shouldMaster is true, master the song
      try
      {
          juce::String title = jsonObj["title"].dump();
          if (title.isQuotedString())
          {
              title = title.unquoted ();
          }

          bool isVibe = false;
          if (jsonObj["songStructure"] == nullptr)
          {
              isVibe = true;
          }

          juce::File exportedFile = saveAndExportSong (title, shouldGenerateMelody, shouldMaster, isVibe);
      }
      catch (const std::exception &e)
      {
          std::cerr << "Error occurred while saving and exporting: " << e.what () << std::endl;
      }
  }

  nlohmann::json performGetArrangementComplete (const juce::String &endpoint, juce::String genre)
  {
      auto patternData = generateVibeJSON (genre, 2);
      return performGetArrangement (endpoint, patternData);
  }

  nlohmann::json performGetArrangement (const juce::String &endpoint, const nlohmann::json &patternData)
  {
      if (patternData == NULL) return {};

      RestRequest::Response restRequestResponse = casperakiApi->post (endpoint, patternData);
      auto jsonResponse = restRequestResponse.body;

      DBG("STATUS of request is: " + juce::String(restRequestResponse.status));
      DBG("RESULT of request is: " + restRequestResponse.headers.getDescription());

      juce::String jsonDump (jsonResponse.dump ());
      // Check if the response is null or a fail response

      DBG ("json response");
      DBG (jsonResponse.dump ());

      return jsonResponse;
  }

  void startBulk (juce::String genre, int bulkCount)
  {
      DBG("===================== Generating " << bulkCount << " " << genre);

      for (int i = 0; i < bulkCount; i++)
      {
          DBG("------- STARTING for " << genre << " #" << i);
          casperakiEngine->prepareEdit (genre);

          //   songData = casperakiApi->post ("getArrangementFull", transformedPatternData).body;

          nlohmann::json songData = performGetArrangementComplete ("getArrangementFull", genre);

          try
          {
              if (songData.is_null ())
              {
                  DBG("Error generating SONG for " << genre << " #" << i);
                  continue;
              }

              loadSongData (songData);
              casperakiEngine->exportSongWithoutMelody (genre);
          }
          catch (const std::exception& e)
          {
              DBGEL("Error generating " << genre << " #" << i << ": " << e.what ());
          }

          DBGEL("------- DONE for " << genre << " #" << i);
      }
  }

  json generateVibeJSON (String genre = "edm", int busyness = 2)
  {
      json vibeData = R"(
            {
              "state": "unloaded",
              "default": true,
              "key": "C",
              "tempo": 100,
              "structure": [
                {
                  "segment": "default"
                }
              ],
              "patterns": [
                {
                  "lengthInBars": 2,
                  "bpm": 100,
                  "pattern": []
                }
              ]
            }
        )"_json;

      vibeData["genre"] = genre.toStdString ();

      //DBG ("\n");
      //DBG ("Genre is: " + juce::String (vibeData["genre"].dump ()));
      //DBG ("VibeDataJSON: ");
      //DBG (vibeData.dump ());
      //DBG ("\n");

      json patternJSON = {{"genre", genre.toStdString ()}, {"busyness", busyness}};

      //DBG ("\n");
      //DBG ("Pattern JSON is:");
      //DBG (patternJSON.dump ());
      //DBG ("\n");

      auto response = casperakiApi->post ("getPattern", {{"genre", genre.toStdString ()}, {"busyness", std::to_string (busyness)}});

      if (response.result.failed ())
      {
          DBG("getPattern failed: " << response.result.getErrorMessage ());
          return {};
      }

      vibeData["patterns"][0]["pattern"] = response.body.at ("pattern");
      juce::String bpmString = juce::String (response.body.at ("bpm").dump ());
      juce::String lengthInBarsString = juce::String (response.body.at ("lengthInBars").dump ());
      try
      {
          int bpm = std::atoi (bpmString.toRawUTF8 ());
          vibeData["tempo"] = bpm;
          vibeData["patterns"][0]["bpm"] = bpm;

          int lengthInBars = std::atoi (lengthInBarsString.toRawUTF8 ());
          vibeData["patterns"][0]["lengthInBars"] = lengthInBars;
      }
      catch (json::out_of_range &e)
      {
          DBG(e.what ());
      }
      catch (json::type_error &e)
      {
          DBG(e.what ());
      }

      //    loadSongData(vibeData);


      //Should we print the vibe data?
      //DBG("Vibe DATA: \n" << vibeData.dump (2));
      return vibeData;
  }

  void loadSongData (const json &songData)
  {
      preDownloadInstrumentSamples (songData);
      json instrumentPatterns = loadSongInstruments(songData);
      json preparedSongData = getPreparedSongData (songData, instrumentPatterns);

      casperakiEngine->setSong (preparedSongData.dump ());
  }

  void preDownloadInstrumentSamples (const json &songData)
  {
      juce::Array<int> sampleIds;
      juce::Array<int> vstIds;

      json songPattern = json::array ();
      if (songData.contains ("patterns") && songData["patterns"].is_array ()
          && !songData["patterns"].empty () && songData["patterns"][0].contains ("pattern"))
          songPattern = songData["patterns"][0]["pattern"];
      if (songPattern.is_array ())
      {
          for (json::iterator it = songPattern.begin(); it != songPattern.end(); ++it)
          {
              if ((*it).contains ("instrumentType") && (*it)["instrumentType"].get<std::string> () == "drums")
              {
                  // drums instrument
                  if (!(*it).contains("instrumentIds") ) continue;

                  for (auto &[name, instrumentId]: (*it)["instrumentIds"].items ())
                  {
                      sampleIds.addIfNotAlreadyThere (instrumentId.get<int> ());
                  }
              }
              else
              {
                  // normal instrument
                  auto instrumentData = loadNormalInstrumentData (*it);
                  if (instrumentData["type"].get<std::string> () == "percussionLoops")
                  {
                      sampleIds.addIfNotAlreadyThere (instrumentData["id"].get<int> ());
                  }
                  else if (instrumentData.contains ("samples"))
                  {
                      // load samples from the instrument
                      for (auto sample : instrumentData["samples"])
                      {
                          vstIds.addIfNotAlreadyThere (sample["id"].get<int> ());
                      }
                  }
              }
          }
      }

      if (songData.contains ("arrangement"))
      {
          for (auto &[segmentName, segmentData]: songData["arrangement"].items ())
          {
              if (!segmentData.contains ("transitions")) continue;

              for (auto &[transitionName, transitionData]: segmentData["transitions"].items ())
              {
                  if (transitionData["lowLevelType"].get<std::string> () == "fxNoiseRise")
                  {
                      continue;
                  }

                  if (transitionData["oneShotOrPattern"].get<std::string> () == "pattern")
                  {
                      String sampleOrVst = transitionData["sampleOrVst"].get<std::string> ();
                      if (sampleOrVst.toLowerCase ().contains ("sample"))
                          sampleIds.addIfNotAlreadyThere (transitionData["sampleIds"][0].get<int> ());
                      if (sampleOrVst.toLowerCase () == "twosamples")
                          sampleIds.addIfNotAlreadyThere (transitionData["sampleIds"][1].get<int> ());
                  }
                  else
                  {
                      sampleIds.addIfNotAlreadyThere (transitionData["id"].get<int> ());
                  }
              }
          }
      }

      DBG("Pre-downloading samples: " << sampleIds.size() << " samples" << " and " << vstIds.size() << " vsts");

      // get tracktion temporary folder
      File tempDirectory = casperakiEngine->getEdit ()->engine.getTemporaryFileManager().getTempDirectory ();

      SamplesBulkDownloadTask download_task = SamplesBulkDownloadTask (baseURL, tempDirectory, sampleIds, vstIds);

      download_task.run ();

      DBG("Finished pre-downloading samples");
  }

  json loadSongInstruments(const json &songData)
  {
      //    std::cout << "Loading song data after transformation: " << std::endl;

      // TODO: reset song (remove all instruments, etc.);

      json songPattern = json::array ();
      if (songData.contains ("patterns") && songData["patterns"].is_array ()
          && !songData["patterns"].empty () && songData["patterns"][0].contains ("pattern"))
          songPattern = songData["patterns"][0]["pattern"];
      if (songPattern.is_array ())
      {
          // Start the timer
          auto start = std::chrono::high_resolution_clock::now();

          // Your existing code block
          for (json::iterator it = songPattern.begin(); it != songPattern.end(); ++it)
          {
              if ((*it).contains("instrumentType") && (*it)["instrumentType"].get<std::string>() == "drums")
              {
                  (*it)["instrumentId"] = 100;
              }

              try
              {
                  addInstrument(*it);
              }
              catch (const std::exception& e)
              {
                  juce::Logger::writeToLog("Unable to add instrument.");
                  juce::Logger::writeToLog((*it).dump());
              }
          }

          // Stop the timer
          auto stop = std::chrono::high_resolution_clock::now();

          // Calculate duration
          auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(stop - start);
          // Log the duration using JUCE's logger
          juce::Logger::writeToLog ("Time taken to add all instruments: " + juce::String(duration.count()) + " milliseconds");
          std::cout << ("Time taken to add all instruments: " + juce::String(duration.count()) + " milliseconds");

          DeferredLogger& logger = DeferredLogger::getInstance();
          logger.logMessage ("Time taken to add all instruments: " + juce::String(duration.count()) + " milliseconds");

      }

      if (songData.contains ("arrangement"))
      {
//          juce::Logger::writeToLog ("Song data contains arrangement.");

          for (auto &[segmentName, segmentData]: songData["arrangement"].items ())
          {
              if (!segmentData.contains ("transitions")) continue;

              for (auto &[transitionName, transitionData]: segmentData["transitions"].items ())
              {
                  json instrumentData = {
                      {"name", transitionData["name"]},
                      {"lowLevelType", transitionData["lowLevelType"]},
                      {"transitionId", transitionData["transitionId"].get<int>()},
                  };

                  if (transitionData["lowLevelType"].get<std::string> () == "fxNoiseRise")
                  {
                      instrumentData["id"] = 104;
                      instrumentData["type"] = "transitionNoise";
                      instrumentData["details"] = {{"frequencyStart", transitionData["frequencyStart"]}};

//                    juce::Logger::writeToLog ("JSON SET: transitionData['lowLevelType'].get<std::string> () == 'fxNoiseRise'. \n");

                  }
                  else if (transitionData["oneShotOrPattern"].get<std::string> () == "pattern")
                  {
                      instrumentData["id"] = transitionData.contains ("id") ? transitionData["id"].get<int> () :
                          100000 + transitionData["transitionId"].get<int> ();
                      instrumentData["type"] = "transitionPattern";

                      // grab samples
                      String sampleOrVst = transitionData["sampleOrVst"].get<std::string> ();
                      if (sampleOrVst.toLowerCase ().contains ("sample"))
                      {
                          instrumentData["sampleOrVst"] = "sample";
                          instrumentData["samples"] = json::array ();
                          instrumentData["samples"].push_back ({
                                                                   {"note", "C1"},
                                                                   {"id", transitionData["sampleIds"][0].get<int> ()}
                                                               });

                          // if has 2 samples, add the second
                          if (sampleOrVst.toLowerCase () == "twosamples")
                          {
                              instrumentData["samples"].push_back ({
                                                                       {"note", "G1"},
                                                                       {"id", transitionData["sampleIds"][1].get<int> ()}
                                                                   });
                          }

//                          juce::Logger::writeToLog ("JSON SET: transitionData['oneShotOrPattern'].get<std::string> () == 'pattern' \n");
                      }
                      else if (sampleOrVst.toLowerCase ().contains ("vst"))
                      {
                          String endpoint = URL ()
                              .withNewSubPath ("vstSamples")
                              .withParameter ("vst", instrumentData.contains ("genre")
                                  ? String (instrumentData["genre"].get<int> ()) : String ())
                              .toString (true);
                          auto response = casperakiApi->get (endpoint);
                          instrumentData["samples"] = response.body;
                      }
                  }
                  else
                  {
                      instrumentData["id"] = transitionData.contains ("id") ? transitionData["id"].get<int> () :
                          100000 + transitionData["transitionId"].get<int> ();

//                      juce::Logger::writeToLog ("modified instrument id is " + instrumentData["id"].dump());

                      instrumentData["type"] = "transitionSample";
                      if (transitionData.contains ("sampleDetails")) instrumentData["details"] = transitionData["sampleDetails"];
                      else instrumentData["details"] = json::object ();

                      if (!instrumentData["details"].contains ("bpm"))
                          instrumentData["details"]["bpm"] = songData["tempo"];
                  }

                  instrumentData["instrumentGroup"] = getInstrumentGroup (instrumentData["lowLevelType"].get<std::string> ());

                  //                 juce::Logger::writeToLog ("ADDING TRANSITION!: " + instrumentData.dump (2));

                  casperakiEngine->addInstrument (instrumentData.dump(), getBaseURL ());
              }
          }
      }

      return songPattern;
  }

  json getPreparedSongData (const json &songData, const json &instrumentPatterns)
  {
      juce::Logger::writeToLog ("Preparing SongData");

      json preparedSongData;

      preparedSongData["key"] = songData.at ("key").
          get<std::string> ();

      if (songData.contains ("id"))
      {
          preparedSongData["id"] = songData.at ("id").
              get<int> ();
      }

      if (songData.contains ("scale"))
      {
          preparedSongData["scale"] = songData.at ("scale").
              get<std::string> ();
      }

      if (songData.contains ("arrangement"))
      {
          preparedSongData["arrangement"] = songData.at ("arrangement");
      }
      preparedSongData["structure"] = songData.contains ("songStructure") ? songData.at ("songStructure") : songData.at ("structure");
      preparedSongData["patterns"][0]["pattern"] = instrumentPatterns;

      // get tempo whether it comes as int or string
      if (songData.contains ("tempo")) {
          if (songData.at ("tempo").is_number_integer ()) {
              preparedSongData["tempo"] = songData.at ("tempo").get<int> ();
          } else if (songData.at ("tempo").is_string ()){
              preparedSongData["tempo"] = std::stoi(songData.at ("tempo").get<std::string> ());
          } else {
              preparedSongData["tempo"] = 90;
          }
      } else preparedSongData["tempo"] = 90;

//      juce::Logger::writeToLog(songData["genre"].dump());

      if (!songData.contains ("genre") || songData.at ("genre").is_null())
      {
          auto patterns = songData["patterns"];
          json genre = patterns.at(0).contains("genre");
          preparedSongData["genre"] = genre;
      }
      else
      {
          preparedSongData["genre"] = songData.contains ("genre")
              ? songData.at ("genre").get<std::string> ()
              : songData.at ("style").get<std::string> ();
      }

      // juce::Logger::writeToLog (songData.dump());

      //The below is obsolete
      if (songData.contains ("default"))
      {
          preparedSongData["default"] = songData["default"].
              get<bool> ();
      }

      //If it isn't a song, it's a vibe
      if (!songData.contains ("songStructure"))
          preparedSongData["isVibe"] = true;

      juce::Logger::writeToLog ("Song data has been prepared.\n");
      // juce::Logger::writeToLog ("preparedSongData: " + preparedSongData.dump (2) + "\n");
      return preparedSongData;
  }

  void addInstrument (const json &instrumentData)
  {
      json instrumentDataToLoad;
      if (instrumentData.at ("instrumentName").get<std::string> () == "Drums"
          || instrumentData.at ("instrumentId").get<int> () == 100)
      {
          instrumentDataToLoad = loadDrumsData (instrumentData);
      }
      else
      {
          instrumentDataToLoad = loadNormalInstrumentData (instrumentData);
      }

      // juce::Logger::writeToLog ("ADDING INSTRUMENT!: " + instrumentDataToLoad.dump (2));
      casperakiEngine->addInstrument (instrumentDataToLoad.dump (), getBaseURL ());
  }

  void save ()
  {
      casperakiEngine->save ();
  }

  void loadConfigFromApi ()
  {
      config = metaDatabase->getOrLoadCachedData ("config", [&]{
            auto response = casperakiApi->get ("config");
            DBG("CONFIG: " << response.bodyAsString);

            if (response.status == 0)
                std::cerr << "Something is wrong with staging.casperaki.com. Either the certificate is invalid, or it is returning an empty response." << std::endl;

            return response.body;
      });
  }

  //================== util functions
  json instrumentFromServerData (const json &instrumentData)
  {
      json newInstrumentData = json::object ();

      newInstrumentData["id"] = instrumentData.at (instrumentData.contains ("id") ? "id" : "instrumentId").get<int> ();
      newInstrumentData["type"] = instrumentData.at ("highLevelType").get<std::string> ();
      newInstrumentData["lowLevelType"] = instrumentData.at ("lowLevelType").get<std::string> ();    

      if (instrumentData.contains ("sampleDetails") && !instrumentData.at ("sampleDetails").is_null ())
          newInstrumentData["details"] = instrumentData.at ("sampleDetails");
      else if (instrumentData.contains ("vstDetails") && !instrumentData.at ("vstDetails").is_null ())
          newInstrumentData["details"] = instrumentData.at ("vstDetails");

      newInstrumentData["isVst"] = instrumentData.at ("type").get<std::string> () == "vst";
      newInstrumentData["isSample"] = instrumentData.at ("type").get<std::string> () == "sample";

      if (instrumentData.contains ("samples"))
        newInstrumentData["samples"] = instrumentData.at ("samples");

      if (instrumentData.contains ("virtualGuitaristSamples"))
          newInstrumentData["virtualGuitaristSamples"] = instrumentData.at ("virtualGuitaristSamples");


      return newInstrumentData;
  }

  std::string getInstrumentType (std::string lowLevelType)
  {
      juce::Array<String> instruments = {"guitar", "bass", "brass", "string", "synth", "piano", "pad", "drums", "loop"};
      String lowLevelTypeStr = {lowLevelType};

      for (auto it = instruments.begin (); it != instruments.end (); ++it)
      {
          if (lowLevelTypeStr.toLowerCase ().contains (*it))
              return it->toStdString ();
      }

      return {""};
  }

  json loadDrumsData (const json &instrumentData)
  {
      json newInstrumentData = json::object ();

      newInstrumentData["id"] = 100;
      newInstrumentData["name"] = "Drums";
      newInstrumentData["type"] = "drums";
      newInstrumentData["lowLevelType"] = "drums";
      newInstrumentData["shortName"] = "drums";
      newInstrumentData["ids"] = instrumentData["instrumentIds"];
      newInstrumentData["busyness"] = instrumentData["drumsBusyness"];
      newInstrumentData["patternStyle"] = instrumentData["drumsPatternStyle"];
      newInstrumentData["subInstruments"] = json::object ();

      if (!newInstrumentData["ids"].is_object () || newInstrumentData["ids"].size () == 0)
      {
          return newInstrumentData;
      }

      std::map<std::string, int> idsToLoadFromApi;
      for (auto &[name, instrumentId]: newInstrumentData["ids"].items ())
      {
          auto subInstData = metaDatabase->getMetaData(juce::String{instrumentId.get<int>()});
          if (subInstData.is_null()) {
              idsToLoadFromApi[name] = instrumentId.get<int> ();
          } else {
              newInstrumentData["subInstruments"][name] = subInstData;
          }

      }

      // if all sub instruments are cached, return the newInstrumentData
      if (idsToLoadFromApi.size () > 0)
      {
          std::vector<int> idsArray = {};
          for (auto &[name, id]: idsToLoadFromApi)
              idsArray.push_back (id);
          nlohmann::json payload = { {"ids", idsArray } };

          juce::String endpoint = "instruments/findTypes";
          auto response = casperakiApi->post (endpoint, payload);
          if (response.result.failed ())
          {
              j::String error = "Error retrieving drums instruments types for idsToLoadFromApi. info: " + response.result.getErrorMessage ();
              throw std::runtime_error(error.toStdString ());
          }

          if (!response.body.is_array()){
              j::String error = "Error retrieving drums instruments types for idsToLoadFromApi. info: Response body is not an array";
              throw std::runtime_error(error.toStdString ());
          }

          juce::String preShiftsEndpoint = "drumKitPreshifts";
          nlohmann::json preShiftsPayload = { {"kit", idsToLoadFromApi } };
          auto preShiftsResponse = casperakiApi->post (preShiftsEndpoint, preShiftsPayload);
          if (preShiftsResponse.result.failed ())
          {
              j::String error = "Error retrieving drums preshifts instruments types for idsToLoadFromApi. info: " + response.result.getErrorMessage ();
              throw std::runtime_error(error.toStdString ());
          }

          // function to get the drums name for an id
          auto getNameForId = [&] (int id)
          {
              for (auto &[name, instrumentId]: newInstrumentData["ids"].items ())
              {
                  if (instrumentId.get<int> () == id)
                      return name;
              }
              return std::string ("");
          };

          for (auto& subInstrumentData : response.body) {
              int instrumentId = subInstrumentData["id"].get<int> ();
              auto name = getNameForId(instrumentId);
              newInstrumentData["subInstruments"][name] = instrumentFromServerData (subInstrumentData);
              newInstrumentData["subInstruments"][name]["instrumentGroup"] = getInstrumentGroup (subInstrumentData["lowLevelType"].get<std::string> ());
              newInstrumentData["subInstruments"][name]["preshift"] = preShiftsResponse.body["kit"][name].get<double> ();

              metaDatabase->setMetaData(juce::String{instrumentId}, newInstrumentData["subInstruments"][name]);
          }
      }
      return newInstrumentData;
  }

  json loadNormalInstrumentData (const json &instrumentData)
  {
      int id = instrumentData["instrumentId"].get<int> ();

      json retInstrumentData = metaDatabase->getOrLoadCachedData(juce::String{id},  [&] {
          juce::String endpoint = "instrument/";
          endpoint << instrumentData["instrumentId"].get<int> ();
          endpoint << "?getSamples=true";

          juce::Logger::writeToLog ("Endpoint Instrument URL for Matthias: " + endpoint);
          auto response = casperakiApi->get (endpoint);

          if (response.result.failed ())
          {
              juce::Logger::writeToLog (response.bodyAsString);
              j::String error = "Error retrieving instrument " + juce::String (instrumentData["instrumentId"].get<int>()) + " info: "
                      + response.result.getErrorMessage ();
              juce::Logger::writeToLog (error);
              jassertfalse;
              // Bail out BEFORE parsing the (empty/error) body — otherwise
              // getOrLoadCachedData would cache the garbage response permanently.
              throw std::runtime_error (error.toStdString ());
          }


          json newInstrumentData = instrumentFromServerData (response.body);

          if (response.body.contains ("overrideLUFS") && !response.body["overrideLUFS"].is_null ()
                  && newInstrumentData.contains ("details"))
          {
              // DBG("Overriding LUFS!");
              newInstrumentData["details"]["LUFS"] = response.body["overrideLUFS"];
          }

          if (response.body.contains ("overrideOctaveAdjustment") && !response.body["overrideOctaveAdjustment"].is_null ()
                  && newInstrumentData.contains ("details"))
          {
              DBG("Overriding OctaveAdjustment!");
              newInstrumentData["details"]["octaveAdjustment"] = response.body["overrideOctaveAdjustment"];
          }

          if (newInstrumentData["type"].get<std::string> () == "basses")
          {
              newInstrumentData["busyness"] = instrumentData.contains ("bassBusyness") ? instrumentData["bassBusyness"].get<int> () : 2;
          }

          if (instrumentData.contains ("instrumentName"))
              newInstrumentData["name"] = instrumentData["instrumentName"].get<std::string> ();
          else if (instrumentData.contains ("details") && instrumentData["details"].contains ("vstPlugin"))
              newInstrumentData["name"] = instrumentData["details"]["vstPlugin"].get<std::string> ();
          else if (instrumentData.contains ("details") && instrumentData["details"].contains ("original"))
              newInstrumentData["name"] = instrumentData["details"]["original"].get<std::string> ();
          else newInstrumentData["name"] = "";

          std::string instrumentLowLevelType = newInstrumentData["lowLevelType"].get<std::string> ();

          newInstrumentData["shortName"] = getInstrumentType (instrumentLowLevelType);

          newInstrumentData["instrumentGroup"] = getInstrumentGroup (instrumentLowLevelType);

          // DBG ("Instrument low level type is: " + juce::String (instrumentLowLevelType));
          // DBG ("Instrument group is: " + newInstrumentData["instrumentGroup"].dump ());

          return newInstrumentData;
      });

      return retInstrumentData;
  }

  std::string getInstrumentGroup (const std::string &lowLevelType)
  {
      json instrumentLowLevelTypes = config["instrumentLowLevelTypes"];
      for (auto &[groupName, groupLowLevelTypes]: instrumentLowLevelTypes.items ())
      {
          if (std::find (groupLowLevelTypes.begin (), groupLowLevelTypes.end (), lowLevelType)
              != groupLowLevelTypes.end ())
          {
              return groupName;
          }
      }
      return {};
  }

  void
  generateInstrumentalBulk (juce::String genreText = "ballad", int numSongsToGenerate = 1, juce::String endpointURL = "https://staging.casperaki.com")
  {
      std::cout << ("Successfully loaded config from API") << std::endl;
      startBulk (genreText, numSongsToGenerate);
      std::cout << ("Successfully generated instrumental") << std::endl;
  }

  juce::File getEditParentFolder()
  {
      casperakiEngine->getEdit()->engine.getTemporaryFileManager().getTempFile("casperaki").setAsCurrentWorkingDirectory();
      auto fileName = casperakiEngine->getEdit()->editFileRetriever().getParentDirectory().getFileName();
      auto file = casperakiEngine->getEdit()->engine.getTemporaryFileManager().getTempFile (fileName);
      return file;
  }

  juce::String getProjectItemIDAsSuitableFilenameString() { return casperakiEngine->getEdit()->getProjectItemID().toStringSuitableForFilename(); }

  juce::String baseURL;

  juce::String getBaseURL() {return baseURL;}

  void setBaseURL (juce::String newURL) {baseURL = newURL;}

  JUCE_DECLARE_NON_COPYABLE (InstrumentalGenerator);

#if JUCE_EMSCRIPTEN
    void loadSongDataStr(const std::string &songDataStr)
    {
        std::string songDataStrCopy = songDataStr;
        nlohmann::json songData = nlohmann::json::parse(songDataStrCopy);
        return loadSongData(songData);
    }
#endif
};

#if JUCE_EMSCRIPTEN

#include <emscripten/bind.h>

EMSCRIPTEN_BINDINGS(instrumental_generator)
{
    emscripten::class_<InstrumentalGenerator>("InstrumentalGenerator")
        .function("loadSongDataStr", &InstrumentalGenerator::loadSongDataStr);
}

#endif
