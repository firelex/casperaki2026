#pragma once
#include <JuceHeader.h>
#include <iostream>
#include "./json.hpp"

class MetaDatabase {
public:
	MetaDatabase()
	{
		initialiseDatabase();
	}

	// get metadata from database or call the callback to set it
	nlohmann::json getOrLoadCachedData(juce::String id, std::function<nlohmann::json()> callback)
	{
		nlohmann::json data = getMetaData(id);
		if (data.empty())
		{
			data = callback();
			setMetaData(id, data);
		}
		return data;
	}

	void setMetaData(juce::String instrumentId, const nlohmann::json& data)
	{
		juce::File newFile = databaseDirectory.getChildFile(instrumentId + ".json");
    newFile.create();
		newFile.replaceWithText(data.dump());
	}

	nlohmann::json getMetaData(juce::String instrumentId)
	{
		nlohmann::json retrievedData;
		juce::File cacheFile = databaseDirectory.getChildFile(instrumentId + ".json");
		if (cacheFile.existsAsFile())
		{
			juce::String data = cacheFile.loadFileAsString();
			try
			{
				retrievedData = nlohmann::json::parse(data.toRawUTF8());
			}
			catch (const std::exception& e)
			{
				// Corrupt cache entry — treat as a miss and delete it so it
				// gets re-fetched instead of poisoning every subsequent read.
				juce::Logger::writeToLog("Corrupt metadata cache for " + instrumentId + ": " + juce::String(e.what()));
				cacheFile.deleteFile();
				return {};
			}
		}
		return retrievedData;
	}

	~MetaDatabase() {}

private:
	void initialiseDatabase()
	{
#if JUCE_ANDROID
    databaseDirectory = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("db/");
#else
		databaseDirectory = juce::File::getSpecialLocation(juce::File::currentApplicationFile).getChildFile("../db/");
#endif
		if (!databaseDirectory.isDirectory())
			databaseDirectory.createDirectory();
	}

	juce::File databaseDirectory;
};
