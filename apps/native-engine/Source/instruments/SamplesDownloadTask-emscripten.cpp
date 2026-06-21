
#include <JuceHeader.h>
#include "SamplesDownloadTask.h"
#include "SamplesDownloadTaskUtils.h"
#include "../json.hpp"

#include <emscripten.h>
#include <emscripten/fetch.h>

// void downloadSucceeded(emscripten_fetch_t *fetch);
//
// void downloadFailed(emscripten_fetch_t *fetch);

class SamplesDownloadTask : public juce::Thread
{
public:
    SamplesDownloadTask(tracktion_engine::Edit &_edit, juce::String _baseUrl, juce::String _filePrefix, juce::DynamicObject::Ptr _ids) : Thread("SampleDownloadTaskThread", 0), edit(_edit), filePrefix(_filePrefix), baseUrl(_baseUrl), ids(_ids)
    {
    }

    ~SamplesDownloadTask()
    {
        DBG("SamplesDownloadTask DESTROYED!!!!");
    }

    void run() override
    {
        auto idsProps = ids->getProperties();

        DBG("run: " << std::this_thread::get_id());

        juce::File cacheFolder{getEditSampleFolderName(edit)};
        cacheFolder.createDirectory();

        // filter files that are already downloaded
        for (int i = idsProps.size(); --i >= 0;)
        {
            auto propName = idsProps.getName(i);
            auto tempFile = cacheFolder.getChildFile(filePrefix + "-" + idsProps.getValueAt(i).toString() + ".ogg");
            if (tempFile.exists() && tempFile.getSize() > 0)
            {
                files.get()->insert(std::make_pair(propName.toString(), getEditDirCopyFile(edit, tempFile)));
                idsProps.remove(propName);
            }
        }

        if (idsProps.size() == 0)
        {
            return;
        }

        if (idsProps.size() == 1 || baseUrl.endsWith("/virtualGuitaristSample/load/"))
        {
            iteractiveDownload(idsProps);
        }
        else
        {
            bulkDownload(idsProps);
        } 

        // fill files map
        for (auto it = idsProps.begin(); it != idsProps.end(); it++)
        {
            juce::File tempFile = cacheFolder.getChildFile(filePrefix + "-" + it->value.toString() + ".ogg");
            files.get()->insert(std::make_pair(it->name.toString(), getEditDirCopyFile(edit, tempFile)));
        }
    }

    FileMapPtr getFiles()
    {
        return files;
    }

private:
    tracktion_engine::Edit &edit;
    juce::DynamicObject::Ptr ids;
    juce::String filePrefix;
    juce::String baseUrl;

    FileMapPtr files = std::make_shared<std::unordered_map<juce::String, juce::String>>();

    void iteractiveDownload(juce::NamedValueSet &idsProps)
    {

        emscripten_fetch_attr_t attr;
        emscripten_fetch_attr_init(&attr);
        strcpy(attr.requestMethod, "GET");
        attr.userData = this;
        attr.attributes = EMSCRIPTEN_FETCH_LOAD_TO_MEMORY | EMSCRIPTEN_FETCH_SYNCHRONOUS;
        // attr.onsuccess = downloadSucceeded;
        // attr.onerror = downloadFailed;

        for (auto it = idsProps.begin(); it != idsProps.end(); it++)
        {
            juce::String urlStr{};
            urlStr << baseUrl << it->value.toString() << "?format=ogg";
            juce::URL url{urlStr};

            juce::File cacheFolder{getEditSampleFolderName(edit)};
            juce::File tempFile = cacheFolder.getChildFile(filePrefix + "-" + it->value.toString() + ".ogg");

            DBG(it->name.toString() << ": " << (int)it->value << "  : " << url.toString(true) << " -> " << tempFile.getFullPathName() << " " << files.use_count());

            emscripten_fetch_t *fetch = emscripten_fetch(&attr, urlStr.toRawUTF8());
            if (fetch->status == 200)
            {
                tempFile.replaceWithData(fetch->data, fetch->numBytes);
            }
            else
            {
                printf("Downloading %s failed, HTTP failure status code: %d.\n", fetch->url, fetch->status);
            }
            emscripten_fetch_close(fetch);
        }
    }

    void bulkDownload(juce::NamedValueSet &idsProps)
    {
        juce::Array<int> sampleIds;
        juce::Array<int> vstIds;

        juce::String urlStr{};

        if (baseUrl.endsWith("playSample/"))
        {
            urlStr = baseUrl.substring(0, baseUrl.indexOf("playSample/")) + "loadManyVstInstruments";
            for (auto it = idsProps.begin(); it != idsProps.end(); it++)
            {
                sampleIds.add((int)it->value);
            }
        }
        else if (baseUrl.endsWith("vstSample/load/"))
        {
            urlStr = baseUrl.substring(0, baseUrl.indexOf("vstSample/load/")) + "loadManyVstInstruments";
            for (auto it = idsProps.begin(); it != idsProps.end(); it++)
            {
                vstIds.add((int)it->value);
            }
        }

        // download zip temp file
        juce::File tempDir = juce::File::getSpecialLocation(juce::File::SpecialLocationType::tempDirectory).getChildFile("casperaki_temp");
        tempDir.createDirectory();
        juce::File zipFile = tempDir.getChildFile("zipsamplesbulk.zip");

        emscripten_fetch_attr_t attr;
        emscripten_fetch_attr_init(&attr);
        strcpy(attr.requestMethod, "POST");
        attr.userData = this;
        attr.attributes = EMSCRIPTEN_FETCH_LOAD_TO_MEMORY | EMSCRIPTEN_FETCH_SYNCHRONOUS;

        const char* headers[] = {"Accept", "*/*",
        "Authorization", "JWT eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJTaW1wbGUgQXV0aCIsInN1YiI6NCwibmFtZSI6InNhbm1hcmlubyIsImF1ZCI6InNpbXBsZWF1dGgiLCJpYXQiOjE2ODI0MTQxMjgsImV4cCI6MTY5MTA1NDEyOCwianRpIjoiZjZjZGM5NTAtOGUxZi00MDc3LTg0ZmUtNDUzNDA2NzQzYzU0In0.kfeEy4vuc7isKEh3_3lE2knbSxjMwWfAQFmikl8cjBTIR7WlVBifLL1EhjZx-UrtKTm1ORJvzCdQfG5RybKcMQ",
        "Content-Type", "application/json", NULL};
        attr.requestHeaders = headers;

        nlohmann::json postData{};
        postData["vstIds"] = vstIds;
        postData["instrumentIds"] = sampleIds;
        postData["format"] = "ogg";
        std::string postDataStr = postData.dump();
        char* postDataCStr = new char [postDataStr.length() + 1];
        std::strcpy(postDataCStr, postDataStr.c_str());

        attr.requestData = postDataCStr;
        attr.requestDataSize = postDataStr.length();

        emscripten_fetch_t *fetch = emscripten_fetch(&attr, urlStr.toRawUTF8());
        if (fetch->status == 200)
        {
            zipFile.replaceWithData(fetch->data, fetch->numBytes);
        }
        else
        {
            printf("Downloading %s failed, HTTP failure status code: %d.\n", fetch->url, fetch->status);
            return;
        }
        emscripten_fetch_close(fetch);

        juce::File unzippedFolder = tempDir.getChildFile ("unzip");
        juce::ZipFile zip (zipFile);
        juce::Result result = zip.uncompressTo (unzippedFolder);
        if (result.failed())
        {
            juce::Logger::writeToLog ("Unzipping failed! " + result.getErrorMessage());
            notify ();
            return;
        }
        
        juce::File cacheFolder{getEditSampleFolderName(edit)};
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
            juce::File newFile = cacheFolder.getChildFile (newFileName);
            file.moveFileTo (newFile);
        }

    }
};

FileMapPtr SampleDownloader::downloadSamples(tracktion_engine::Edit &edit,
                                             juce::String baseUrl,
                                             juce::String filePrefix,
                                             juce::DynamicObject::Ptr ids)
{
    std::cout << "SampleDownloader::downloadSamples: " << std::this_thread::get_id() << std::endl;
    std::cout << "baseUrl: " << baseUrl << " filePrefix: " << filePrefix << "ids count: " << ids->getProperties().size() << std::endl;

    SamplesDownloadTask *samplesDownloadTask = new SamplesDownloadTask(
        edit,
        baseUrl,
        filePrefix,
        ids);

    DBG("startThread: " << std::this_thread::get_id());
    samplesDownloadTask->startThread();
    DBG("startThread Done");

    DBG("waitForThreadToExit");
    samplesDownloadTask->waitForThreadToExit(-1);
    DBG("waitForThreadToExit done");

    samplesDownloadTask->stopThread(-1);
    FileMapPtr files = samplesDownloadTask->getFiles();
    delete samplesDownloadTask;
    return files;
}
