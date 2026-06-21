/*
  ==============================================================================

    SamplesBulkDownloadTask.h
    Created: 26 Jan 2024 4:22:33pm
    Author:  Tiago Alves

  ==============================================================================
*/

#pragma once
#include <JuceHeader.h>
#include "./json.hpp"

using namespace juce;
using json = nlohmann::json;

 class SamplesBulkDownloadTask : public juce::Thread, public juce::URL::DownloadTask::Listener {
 public:
  SamplesBulkDownloadTask (juce::String u, File c, juce::Array<int> s, juce::Array<int> v, juce::String f = "ogg")
      : Thread("SamplesBulkDownloadTask", 0), baseURL (u), cacheDirectory (c), sampleIds (s), vstIds (v), format (f)
  {}

  void run ()
  {
      juce::URL url (baseURL + "/loadManyVstInstruments");

      auto dnlOpts = juce::URL::DownloadTaskOptions ()
          .withListener (this)
          .withUsePost(true)
          .withExtraHeaders ("Accept: */*\r\n"
                             "User-Agent: Thunder Client (https://www.thunderclient.com)\r\n"
                             "host: " + url.getDomain () + "\r\n"
                                                           "Authorization: JWT eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJTaW1wbGUgQXV0aCIsInN1YiI6NCwibmFtZSI6InNhbm1hcmlubyIsImF1ZCI6InNpbXBsZWF1dGgiLCJpYXQiOjE2ODI0MTQxMjgsImV4cCI6MTY5MTA1NDEyOCwianRpIjoiZjZjZGM5NTAtOGUxZi00MDc3LTg0ZmUtNDUzNDA2NzQzYzU0In0.kfeEy4vuc7isKEh3_3lE2knbSxjMwWfAQFmikl8cjBTIR7WlVBifLL1EhjZx-UrtKTm1ORJvzCdQfG5RybKcMQ\r\n"
                                                           "Content-Type: application/json\r\n");

      // filter out the ids already exist in the cache directory
      sampleIds.removeIf ([&] (int sampleId)
                          {
                              return cacheDirectory.getChildFile (
                                  "playsample-" + juce::String (sampleId) + "."
                                  + format).exists ();
                          });

      vstIds.removeIf ([&] (int vstId)
                       {
                           return cacheDirectory.getChildFile (
                               "vstsample-" + juce::String (vstId) + "." + format).exists ();
                       });

      // if nothing to download, return
      if (sampleIds.size () == 0 && vstIds.size () == 0)
      {
            juce::Logger::writeToLog ("Nothing to download!");
          return;
      }

      json postData{};
      postData["vstIds"] = vstIds;
      postData["instrumentIds"] = sampleIds;
      postData["format"] = format.toStdString ();

      DBG("postData: " + postData.dump());

      url = url.withPOSTData (postData.dump ());

      auto tempDir = juce::File::getSpecialLocation (juce::File::SpecialLocationType::tempDirectory).getChildFile ("casperaki_temp");

      // Define the file name
      juce::String fileName = "zipsamplesbulk.zip";

      // Create a File object representing the desired subdirectory
      juce::File zipSamplesFolder = tempDir;

      // Check if the folder already exists, and if not, create it
      if (!zipSamplesFolder.exists ())
      {
          zipSamplesFolder.createDirectory ();
      }

      auto task = url.downloadToFile (zipSamplesFolder.getChildFile (fileName), dnlOpts);
      wait (-1);
  }
 private:

  void finished (juce::URL::DownloadTask *task, bool success) override
  {
      if (!success)
      {
          juce::Logger::writeToLog ("Bulk Samples Download failed!");
          notify ();
          return;
      }

      if (task->statusCode () != 200)
      {
          juce::Logger::writeToLog ("Bulk Samples Download failed! Status code: " + juce::String (task->statusCode ()));
          notify ();
          return;
      }

      juce::Logger::writeToLog ("Bulk Samples Download finished! " + task->getTargetLocation ().getFullPathName ());

      // Unzip the file
        juce::File zipFile = task->getTargetLocation ();
        juce::File tempDir = zipFile.getParentDirectory ();
        juce::File unzippedFolder = tempDir.getChildFile (zipFile.getFileNameWithoutExtension ());
        juce::ZipFile zip (zipFile);
        if (!zip.uncompressTo (unzippedFolder, true))
        {
            juce::Logger::writeToLog ("Unzipping failed!");
            notify ();
            return;
        }

        // Move the files to the cache directory
        juce::Array<juce::File> files;
        unzippedFolder.findChildFiles (files, juce::File::findFiles, true);
        for (auto file : files)
        {
            juce::String fileName = file.getFileName ();
            juce::String newFileName;
            if (fileName.startsWith ("instruments-"))
                 newFileName = "playsample-" + fileName.fromFirstOccurrenceOf ("-", false, true);
            else if (fileName.startsWith ("vsts-"))
                 newFileName = "vstsample-" + fileName.fromFirstOccurrenceOf ("-", false, true);
            else
            {
                juce::Logger::writeToLog ("Invalid file name: " + fileName);
                continue;
            }
            juce::File newFile = cacheDirectory.getChildFile (newFileName);
            file.moveFileTo (newFile);
        }

      notify ();
  }

  juce::String baseURL;
  juce::Array<int> vstIds;
  juce::Array<int> sampleIds;
  juce::String format;
  File cacheDirectory;
};
