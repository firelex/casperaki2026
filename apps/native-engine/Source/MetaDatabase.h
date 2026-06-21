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
		if (databaseDirectory.getChildFile(instrumentId + ".json").existsAsFile())
		{
			juce::String data = databaseDirectory.getChildFile(instrumentId + ".json").loadFileAsString();
			retrievedData = nlohmann::json::parse(data.toRawUTF8());
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
