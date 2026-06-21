//
// Created by Tiago Alves on 10/05/2022.
//
#include <JuceHeader.h>
#include "SamplesDownloadTask.h"
#include <fstream>
#define MINIMP3_IMPLEMENTATION

#include "../config.h"


typedef std::shared_ptr<std::unordered_map<juce::String, juce::String>> FileMapPtr;

class SamplesDownloadTask : public juce::Thread,
private juce::URL::DownloadTask::Listener {
public:
    SamplesDownloadTask(tracktion_engine::Edit &_edit, juce::String _baseUrl, juce::String _filePrefix, juce::DynamicObject::Ptr _ids)
    :
    Thread("SampleDownloadTaskThread", 0), edit(_edit), baseUrl(_baseUrl), filePrefix(_filePrefix), ids(_ids) {
    }
    
    ~SamplesDownloadTask() override {
        DBG ("SamplesDownloadTask DESTROYED!!!!" );
    }
    
    void iterativeRun (juce::String transformedUrl)
    {
        auto idsProps = ids->getProperties();
        bool hasDownloadedFiles = false;

        juce::Logger::writeToLog (" Number of idsProps: " + juce::String (idsProps.size()));

        for (auto it = idsProps.begin(); it != idsProps.end(); it++)
        {
            juce::String urlStr{};
            urlStr << transformedUrl << it->value.toString() << "?format=ogg";
            juce::URL url {urlStr};

            juce::String fileName;
            fileName = filePrefix + "-" + juce::String (it->value.toString()) + ".ogg";
            auto tempFile = edit.engine.getTemporaryFileManager().getTempFile (fileName);

            juce::Logger::writeToLog (fileName + ": " + juce::String ((int) it->value) + "  : " + url.toString (true) + " -> " + tempFile.getFullPathName() + " " + juce::String (files.use_count())  + "\n");

            if (tempFile.exists() && tempFile.getSize() > 0)
            {
                hasDownloadedFiles = true;

#if COPY_TO_SAMPLES_FOLDER
                juce::File sampleFile = copyFileToEditDir (edit, tempFile);
                files.get()->insert (std::make_pair (it->name.toString(), getEditDirCopyFile (edit, sampleFile)));
#else
                files.get()->insert (std::make_pair (it->name.toString(), tempFile.getFullPathName()));
#endif
                downloadTasks.push_back (nullptr);
            }
            else
            {
                auto dnlOpts = juce::URL::DownloadTaskOptions().withListener (this);
                auto downloadTask = url.downloadToFile (tempFile, dnlOpts);
                downloadTasks.push_back (std::move (downloadTask));
                targetIds.set (tempFile.getFullPathName(), it->name.toString());
      //          juce::Logger::writeToLog (fileName + " download task has been added to the list of download tasks. \n");
            }
        }

        if (idsProps.size() == 0)
        {
            juce::Logger::writeToLog ("YOU ARE MISSING SAMPLES ]n");
            std::cerr << "YOU ARE MISSING SAMPLES ]n" << std::endl;
            notify();
        }

        if (hasDownloadedFiles)
        {
            finished (nullptr, true);
        }

        wait (-1);
    }
    
    //As of now, vstsample files are being unzipped upon download.
    
    void batchRun()
    {
        // Create JSON payload
        juce::Array<juce::var> vstIds;
        auto jsonPayload = new juce::DynamicObject();
        
        auto idsProps = ids->getProperties();

        for (auto it = idsProps.begin(); it != idsProps.end(); it++)
        {
            juce::String aggregatedFileName (filePrefix + "-" + juce::String (it->value.toString()) + ".ogg");
            auto tempFile = edit.engine.getTemporaryFileManager().getTempFile (aggregatedFileName);

            if (!tempFile.existsAsFile())
            {
                vstIds.add ((int)it->value);
                juce::Logger::writeToLog ("Added VST ID: " + juce::String ((int) it->value));
            }
        }

        if (vstIds.size() == 0)
        {
            juce::Logger::writeToLog ("No samples to download");
            finished (nullptr, true);
            return;
        }
        
        jsonPayload->setProperty ("vstIds", vstIds);
        
        auto jsonPayloadVar = juce::var (jsonPayload);
        juce::String jsonString = juce::JSON::toString (jsonPayloadVar);
        
        jsonPayload->clear();

        juce::String newUrl;
        int index = baseUrl.indexOf ("load/");
        if (index != -1) {
            newUrl = baseUrl.substring (0, index);  // +5 to include '.com/'
            newUrl += "loadMany?format=ogg";
        }

        juce::Logger::writeToLog ("Download Task:   new URL is " + newUrl);
        juce::Logger::writeToLog ("Domain is: " + juce::URL (newUrl).getDomain());
        
        juce::URL url { newUrl };
        
        // Headers as a string
        juce::String headersString = "Accept: */*\r\n"
        "User-Agent: Thunder Client (https://www.thunderclient.com)\r\n"
        "host: " + url.getDomain() + "\r\n"
        "Authorization: JWT eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJTaW1wbGUgQXV0aCIsInN1YiI6NCwibmFtZSI6InNhbm1hcmlubyIsImF1ZCI6InNpbXBsZWF1dGgiLCJpYXQiOjE2ODI0MTQxMjgsImV4cCI6MTY5MTA1NDEyOCwianRpIjoiZjZjZGM5NTAtOGUxZi00MDc3LTg0ZmUtNDUzNDA2NzQzYzU0In0.kfeEy4vuc7isKEh3_3lE2knbSxjMwWfAQFmikl8cjBTIR7WlVBifLL1EhjZx-UrtKTm1ORJvzCdQfG5RybKcMQ\r\n"
        "Content-Type: application/json\r\n";


        
        // Attach headers and POST data to the URL
        url = url.withPOSTData (jsonString);
        
        auto dnlOpts = juce::URL::DownloadTaskOptions()
                .withListener (this)
                .withExtraHeaders (headersString);
        auto tempDir = edit.engine.getTemporaryFileManager().getTempDirectory();
        
        // Define the folder name
        juce::String folderName = "zipsamples.zip";
        
        // Create a File object representing the desired subdirectory
        juce::File zipSamplesFolder = tempDir;
        
        // Check if the folder already exists, and if not, create it
        if (!zipSamplesFolder.exists())
        {
            zipSamplesFolder.createDirectory();
        }
        
        auto downloadTask = url.downloadToFile (zipSamplesFolder.getChildFile (folderName), dnlOpts);
        
        jassert (downloadTask != nullptr);
        downloadTasks.push_back (std::move (downloadTask));
        
        finished (nullptr, true);
        
        wait (-1);
    }
    
    bool isZipFile = false;
    void run() override
    {
#if JUCE_ANDROID
        isZipFile = false;
        iterativeRun (baseUrl);
#else
        if (baseUrl.endsWith ("/playSample/"))
        {
            isZipFile = false;
            iterativeRun (baseUrl);
        }
        else if (baseUrl.endsWith ("/virtualGuitaristSample/load/"))
        {
            isZipFile = false;
            iterativeRun (baseUrl);
        }
        else if (baseUrl.endsWith ("/vstSample/load/"))
        {
            isZipFile = true;
            batchRun();
        }
        else
        {
            std::cerr << "You have not accounted for this URL: " << baseUrl << std::endl;
        }
#endif
    }
    
    void unzipFile()
    {
        auto tempDir = edit.engine.getTemporaryFileManager().getTempDirectory();
        
        // Define the folder name
        juce::String folderName = "zipsamples.zip";
        
        // Create a File object representing the desired subdirectory
        juce::File zipSamplesFolder = tempDir.getChildFile (folderName);

        juce::ZipFile zipArchive (zipSamplesFolder);

        // Create an intermediate directory for extraction
        juce::File intermediateDir = tempDir.getChildFile("intermediate");
        if (!intermediateDir.exists()) {
            intermediateDir.createDirectory();
        }

        // Extract all files to the intermediate directory
        zipArchive.uncompressTo (intermediateDir);

        // Move and rename the files to the target directory
        juce::Array<juce::File> oggFiles;
        intermediateDir.findChildFiles (oggFiles, juce::File::findFiles, true, "*.ogg");

        for (auto& file : oggFiles) {
            juce::String newName = "vstsample-" + file.getFileName();
            juce::File destinationFile = tempDir.getChildFile(newName);

            if (!destinationFile.exists()) {
                file.moveFileTo(destinationFile);
            }
        }
        
        DBG ("number of ogg files: " + juce::String (oggFiles.size()));

        // Optionally, remove the intermediate directory if it's empty
        intermediateDir.deleteRecursively();
        zipSamplesFolder.deleteRecursively();

        notify();
    }
    
    void finished (juce::URL::DownloadTask* task, bool success) override
    {
        juce::Logger::writeToLog ("Entering final stage of download process.");
        
        //If it isn't the unzipped files
        if (!isZipFile) //This means one download task per file
        {
            if (task == nullptr)
            {
                TRACKTION_LOG ( "done cached file " );
            }
            else
            {
                juce::Logger::writeToLog ("task target location: " + task->getTargetLocation().getFullPathName());
                auto targetLocationPath = task->getTargetLocation().getFullPathName();
                auto targetId = targetIds.getValue (targetLocationPath, "");
                juce::Logger::writeToLog ("done file: " + targetLocationPath);

#if COPY_TO_SAMPLES_FOLDER
                juce::File sampleFile = copyFileToEditDir (edit, task->getTargetLocation());
                files.get()->insert(std::make_pair (targetId, getEditDirCopyFile (edit, sampleFile)));
#else
                files.get()->insert(std::make_pair (targetId, targetLocationPath));
#endif
            }
        }
        else
        {
            if (edit.engine.getTemporaryFileManager().getTempFile ("zipsamples.zip").existsAsFile() && task!=nullptr)
                unzipFile();
            copyVstSampleFilesFromCacheIntoFolder();
        }
        
        TRACKTION_LOG ("downloadTasks: " + juce::String(downloadTasks.size()) + " ids: " + juce::String(ids->getProperties().size()) );
        if (
            std::all_of(downloadTasks.begin(), downloadTasks.end(), [](std::unique_ptr<juce::URL::DownloadTask>& task) {
            return  task == nullptr || task.get()->isFinished();
        })
            ) {
            juce::Logger::writeToLog ("FINISHED DOWNLOADING FILES!!!! \n");
            success = true;
            notify();
        }

        success = false;
    }
    
    void copyVstSampleFilesFromCacheIntoFolder()
    {
        //copy the files into the edit directory
        auto idsProps = ids->getProperties();
        for (auto it = idsProps.begin(); it != idsProps.end(); it++)
        {
            juce::String vstSampleFileName = "vstsample-";
            vstSampleFileName += juce::String ((int) it->value) + ".ogg";

            auto vstSampleFile = edit.engine.getTemporaryFileManager().getTempFile (vstSampleFileName);

            if (!vstSampleFile.existsAsFile())
            {
                int id = (int) it->value;
                DBG ("ID " + juce::String (id) + " is missing from array.");
            }
            else
            {

#if COPY_TO_SAMPLES_FOLDER
                juce::File sampleFile = copyFileToEditDir (edit, vstSampleFile.getFullPathName());
                files.get()->insert (std::make_pair (it->name.toString(), getEditDirCopyFile (edit, sampleFile)));
#else
                files.get()->insert (std::make_pair (it->name.toString(), vstSampleFile.getFullPathName()));
#endif
            }
        }
    }
    
    FileMapPtr getFiles()
    {
        return files;
    }

    
private:
    tracktion_engine::Edit &edit;
    juce::String baseUrl;
    juce::String filePrefix;
    juce::DynamicObject::Ptr ids;
    
    juce::StringPairArray targetIds;
    
    std::vector<std::unique_ptr<juce::URL::DownloadTask>> downloadTasks {};
    FileMapPtr files = std::make_shared<std::unordered_map<juce::String, juce::String>>();
};


    
FileMapPtr SampleDownloader::downloadSamples (tracktion_engine::Edit &_edit,
                                juce::String baseUrl, 
                                juce::String filePrefix,
                                juce::DynamicObject::Ptr _ids)
    {
        
        SamplesDownloadTask *samplesDownloadTask = new SamplesDownloadTask (_edit, baseUrl, filePrefix, _ids);
        
#if JUCE_ANDROID
        samplesDownloadTask->startThread();
        TRACKTION_LOG( "startThread Done" );

        TRACKTION_LOG( "waitForThreadToExit" );
        samplesDownloadTask->waitForThreadToExit(-1);
#else
        samplesDownloadTask->run();
#endif
        DBG ("samplesDownloadTask done" );
        
        samplesDownloadTask->stopThread(-1);
        FileMapPtr files = samplesDownloadTask->getFiles();
        delete samplesDownloadTask;
        return files;
    }
