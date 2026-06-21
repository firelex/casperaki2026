//
// Created by Tiago Alves on 06/05/2022.
//

#pragma once

#include <JuceHeader.h>

#include "PresetManager.h"
#include "FXPluginRemap.h"
#include "MixConfig.h"  // docs/65 — runtime mix-config; consulted when loaded()

//Quilio Code below
namespace AudioPluginUtils
{
	//TODO: Add support for other formats
	enum AudioPluginFormats //Supported formats so far
	{
		VST //VST2
	};

    static juce::String getVST2PluginDirectoryPath()
    {
        // Get the current executable's directory
        juce::File currentExecutable = juce::File::getSpecialLocation (juce::File::currentApplicationFile);
        juce::String currentDir = currentExecutable.getParentDirectory().getFullPathName();

#ifdef JUCE_MAC
        return currentDir + "/ExternalPlugins/Mac";
#elif JUCE_WINDOWS
        return currentDir + "\\ExternalPlugins\\Windows";
#else
        return {}; // Return an empty string if neither JUCE_MAC nor JUCE_WINDOWS is defined
#endif
    }

    static juce::String getVST2FileEnding()
    {
        juce::String vst2FileEnding;
#ifdef JUCE_MAC
        vst2FileEnding = "*.vst";
#elif JUCE_WINDOWS
        vst2FileEnding = "*.dll";
#endif
        return vst2FileEnding;
    }

	class TracktionRack
	{
	public:
		TracktionRack() = delete; // This class should not be instantiated

        // Transforms a VST file path to either Windows or macOS directory, while retaining the filename
        // There is some finicky stuff to translate between the different plugin naming systems...
		static juce::String transformVSTPath(const juce::String& oldPath)
		{
			juce::String newPath;

#ifdef JUCE_WINDOWS
			const juce::String windowsDirectory = getVST2PluginDirectoryPath();
            const juce::String windowsSeparatorBackslash = "\\";
            const juce::String windowsSeparatorSlash = "/";

            // Determine which separator is used in the oldPath
            int lastIndexBackslash = oldPath.lastIndexOf(windowsSeparatorBackslash);
            int lastIndexSlash = oldPath.lastIndexOf(windowsSeparatorSlash);

            // Use the separator which occurred last
            juce::String windowsSeparator = (lastIndexBackslash > lastIndexSlash) ? windowsSeparatorBackslash : windowsSeparatorSlash;

            juce::String windowsFilename = oldPath.fromLastOccurrenceOf(windowsSeparator, false, false);
            windowsFilename = windowsFilename.endsWith(".vst") ? windowsFilename.dropLastCharacters(4) + "64.dll" : windowsFilename;
            newPath = windowsDirectory + windowsSeparator + windowsFilename;
#elif defined JUCE_MAC
            const juce::String macDirectory = getVST2PluginDirectoryPath();
            const juce::String macSeparatorBackslash = "\\";
            const juce::String macSeparatorSlash = "/";

            // Determine which separator is used in the oldPath
            int lastIndexBackslash = oldPath.lastIndexOf(macSeparatorBackslash);
            int lastIndexSlash = oldPath.lastIndexOf(macSeparatorSlash);

            // Use the separator which occurred last
            juce::String macSeparator = (lastIndexBackslash > lastIndexSlash) ? macSeparatorBackslash : macSeparatorSlash;

            juce::String macFilename = oldPath.fromLastOccurrenceOf(macSeparator, false, false);

            // Check if it's the Valhalla plugin
            if (macFilename == "ValhallaFreqEcho_x64.dll")
            {
                macFilename = "ValhallaFreqEcho.vst";
            }
            else
            {
                // Remove "64.dll" if it's present, otherwise remove ".dll"
                if (macFilename.endsWith ("64.dll"))
                {
                    macFilename = macFilename.dropLastCharacters (6) + ".vst"; // Drop 7 characters for "64.dll"
                } else if (macFilename.endsWith (".dll"))
                {
                    macFilename = macFilename.dropLastCharacters (4) + ".vst"; // Drop 4 characters for ".dll"
                }
            }

            newPath = macDirectory + "/" + macFilename;
#else
            std::cerr << "Warning: The plugin scanner is currently not intended for platforms other than Windows or Mac OS" << std::endl;
#endif

			if (newPath.isEmpty())
				return oldPath;

			return newPath;
		}

		static juce::String loadXmlWithPluginFilePaths (juce::String& xmlData, const juce::String& newDirectory)
		{
			std::unique_ptr<juce::XmlElement> presetElement(juce::XmlDocument::parse(xmlData));

			if (presetElement == nullptr || !presetElement->hasTagName("PRESET")) return "";

			juce::XmlElement* rackElement = presetElement->getChildByName("RACK");
			if (rackElement == nullptr)
			{
				DBG("Rack element is nullptr");
				return "";
			}

			for (int pluginInstanceIndex = 0; pluginInstanceIndex < rackElement->getNumChildElements(); ++pluginInstanceIndex)
			{
				auto* pluginInstanceElement = rackElement->getChildElement(pluginInstanceIndex);
				if (pluginInstanceElement->hasTagName("PLUGININSTANCE"))
				{
					juce::XmlElement* pluginElement = pluginInstanceElement->getChildByName("PLUGIN");

					if (pluginElement != nullptr)
					{
#if defined(JUCE_LINUX) || defined(JUCE_BSD)
						// docs/57d Linux remap: rewrite legacy VST refs into
						// Tracktion-internal AirWindows xmlTypeNames, Airwindows
						// Consolidated VST3 + algorithm state blob, SimpleSide
						// VST3, or yabridged Valhalla VST2. Returns RemapAction
						// for logging; unmapped slots are left in place for the
						// harness strip to handle.
						auto action = fx_remap::remapPluginElement (*pluginElement);
						if (action == fx_remap::RemapAction::unmapped)
							DBG ("[fx_remap] unmapped plugin: "
								<< pluginElement->getStringAttribute ("filename"));
#else
						const juce::String oldFilePath = pluginElement->getStringAttribute("filename");
						DBG("Old file path: " + oldFilePath);

						if (!oldFilePath.isEmpty())
						{
							//          if (!oldFilePath.startsWith (newDirectory))
							//          {
							const juce::String newFilePath = transformVSTPath(oldFilePath);
							pluginElement->setAttribute("filename", newFilePath);



                            auto newFile = juce::File::getSpecialLocation(juce::File::SpecialLocationType::userApplicationDataDirectory).getParentDirectory().getChildFile (newFilePath);
                            jassert (newFile.exists());
							DBG("New file path: " + newFile.getFullPathName());
							//          }
						}
#endif
					}
				}
			}

			return presetElement.get()->toString();
		}
	};
}

//TODO: Move this to 'ExceptionHandling.h'
class RackPluginCreationException : public std::exception
{
public:
    explicit RackPluginCreationException (const juce::String message) : errorMessage (message.toStdString()) {}

	const char* what() const noexcept override
	{
		return errorMessage.c_str();
	}

private:
	std::string errorMessage;
};

class FX
{
public:

    struct FXSendParameters
    {
        float reverbGainInDb;
        float delayGainInDb;
        float chorusGainInDb;
    };

	enum InstrumentGroup { fx, kicks, drums, percussion, bass, keys, synths, leadSynths, acousticGuitars, electricGuitars, orchestral, snares, toms, vocals };
	inline static std::unordered_map<juce::String, InstrumentGroup> const fxGroupTable =
	{
		{ "fx", InstrumentGroup::fx },
		{ "kicks", InstrumentGroup::kicks },
		{ "drums", InstrumentGroup::drums },
		{ "percussion", InstrumentGroup::percussion },
		{ "bass", InstrumentGroup::bass },
		{ "keys", InstrumentGroup::keys },
		{ "synths", InstrumentGroup::synths },
		{ "leadSynths", InstrumentGroup::leadSynths },
		{ "acousticGuitars", InstrumentGroup::acousticGuitars },
		{ "electricGuitars", InstrumentGroup::electricGuitars },
		{ "orchestral", InstrumentGroup::orchestral },
		{ "snares", InstrumentGroup::snares },
		{ "toms", InstrumentGroup::toms },
		{ "vocals", InstrumentGroup::vocals }
	};

	inline static std::unordered_map<juce::String, juce::String> const typeMappingTable =
	{
		{ "fxAtmosphere", "fx" },
		{ "fxDownlifter", "fx" },
		{ "fxFretNoise", "fx" },
		{ "fxHighImpact", "fx" },
		{ "fxLowImpact", "fx" },
		{ "fxNoiseRise", "fx" },
		{ "fxOther", "fx" },
		// docs/58e — arcade samples (DonkeyKong/Frogger/MsPacMan/PacMan/
		// nintendo, ~15 rows) routed through the fx group. xlsx files
		// them under fxOther+mainStyle=8bit; build-snapshot.ts
		// reclassifies to fx8bitArcade so per-lowLevelType volume tuning
		// (FX::getInstrumentTargetVolume below) can target them.
		{ "fx8bitArcade", "fx" },
		{ "fxReverse", "fx" },
		{ "fxTonalReverse", "fx" },
		{ "fxTransition", "fx" },
		{ "fxUplifter", "fx" },
		{ "kickDrumsAcoustic", "kicks" },
		{ "kickDrumsElectronic", "kicks" },
		{ "clapsSnapsClapsAcoustic", "drums" },
		{ "clapsSnapsClapsElectronic", "drums" },
		{ "clapsSnapsClapsPreshifted", "drums" },
		{ "clapsSnapsSnapsAcoustic", "drums" },
		{ "clapsSnapsSnapsElectronic", "drums" },
		{ "cymbalsCrashHit", "drums" },
		{ "cymbalsElectronic", "drums" },
		{ "cymbalsOrchestral", "drums" },
		{ "cymbalsReverse", "drums" },
		{ "cymbalsRideBell", "drums" },
		{ "cymbalsRideRim", "drums" },
		{ "cymbalsSwell", "drums" },
		{ "drumKitsAcoustic", "drums" },
		{ "drumKitsElectronic", "drums" },
		{ "hiHatsClosedAcoustic", "drums" },
		{ "hiHatsClosedElectronic", "drums" },
		{ "hiHatsOpen", "drums" },
		{ "shakersAcoustic", "drums" },
		{ "shakersElectronic", "drums" },
		{ "snareDrumsAcoustic", "drums" },
		{ "snareDrumsElectronic", "drums" },
		{ "tomsAcoustic", "drums" },
		{ "tomsElectronic", "drums" },
		{ "percussionBreaksBuildups", "percussion" },
		{ "percussionBreaksFills", "percussion" },
		{ "percussionLoopsAcoustic", "percussion" },
		{ "percussionLoopsElectronic", "percussion" },
		{ "percussionMiscAcousticHigh", "percussion" },
		{ "percussionMiscAcousticLow", "percussion" },
		{ "percussionMiscElectronicHigh", "percussion" },
		{ "percussionMiscElectronicLow", "percussion" },
		{ "percussionMiscVocalShout", "percussion" },
		{ "bassesAcoustic", "bass" },
		{ "bassesElectric", "bass" },
		{ "bassesSynth808", "bass" },
		{ "bassesSynthDistorted", "bass" },
		{ "bassesSynthPluck", "bass" },
		{ "bassesSynthSoft", "bass" },
		{ "bassesSynthSub", "bass" },
		{ "bassesSynthWobble", "bass" },
		{ "keysAcousticPiano", "keys" },
		{ "keysChoir", "keys" },
		{ "keysElectronicPiano", "keys" },
		{ "keysOrgan", "keys" },
		{ "synthsArpeggiated", "synths" },
		{ "synthsBrightPad", "synths" },
		{ "synthsPlucked", "synths" },
		{ "synthsSoftPad", "synths" },
		{ "leadSynthsAnalog", "leadSynths" },
		{ "leadSynthsBright", "leadSynths" },
		{ "leadSynthsDistorted", "leadSynths" },
		{ "leadSynthsSoft", "leadSynths" },
		{ "acousticGuitars12StringMono", "acousticGuitars" },
		{ "acousticGuitars12StringStereo", "acousticGuitars" },
		{ "acousticGuitarsBanjoMono", "acousticGuitars" },
		{ "acousticGuitarsBanjoStereo", "acousticGuitars" },
		{ "acousticGuitarsMandolineMono", "acousticGuitars" },
		{ "acousticGuitarsMandolineStereo", "acousticGuitars" },
		{ "acousticGuitarsNylonMono", "acousticGuitars" },
		{ "acousticGuitarsNylonStereo", "acousticGuitars" },
		{ "acousticGuitarsSteelMono", "acousticGuitars" },
		{ "acousticGuitarsSteelStereo", "acousticGuitars" },
		{ "acousticGuitarsUkuleleMono", "acousticGuitars" },
		{ "acousticGuitarsUkuleleStereo", "acousticGuitars" },
		{ "electricGuitarsDominoMono", "electricGuitars" },
		{ "electricGuitarsDominoStereo", "electricGuitars" },
		{ "electricGuitarsLpChorusMono", "electricGuitars" },
		{ "electricGuitarsLpChorusStereo", "electricGuitars" },
		{ "electricGuitarsStratDriveMono", "electricGuitars" },
		{ "electricGuitarsStratDriveStereo", "electricGuitars" },
		{ "electricGuitarsWarmCrunchMono", "electricGuitars" },
		{ "electricGuitarsWarmCrunchStereo", "electricGuitars" },
		{ "orchestralBassLegato", "orchestral" },
		{ "orchestralBassSolo", "orchestral" },
		{ "orchestralCelloLegato", "orchestral" },
		{ "orchestralCelloSolo", "orchestral" },
		{ "orchestralHighBrassLegato", "orchestral" },
		{ "orchestralHighBrassStaccato", "orchestral" },
		{ "orchestralHighStringsPizzicato", "orchestral" },
		{ "orchestralHighStringsStaccato", "orchestral" },
		{ "orchestralHighStringsTremolo", "orchestral" },
		{ "orchestralHit", "orchestral" },
		{ "orchestralLowBrassLegato", "orchestral" },
		{ "orchestralLowBrassStaccato", "orchestral" },
		{ "orchestralLowStringsPizzicato", "orchestral" },
		{ "orchestralLowStringsStaccato", "orchestral" },
		{ "orchestralLowStringsTremolo", "orchestral" },
		{ "orchestralViolaLegato", "orchestral" },
		{ "orchestralViolaSolo", "orchestral" },
		{ "orchestralViolinLegato", "orchestral" },
		{ "orchestralViolinSolo", "orchestral" },
		{ "orchestralWoodwindsLegato", "orchestral" },
		{ "orchestralWoodwindsStaccato", "orchestral" },
		{ "popBrassBrightBrassSectionLegato", "orchestral" },
		{ "popBrassBrightBrassSectionStaccato", "orchestral" },
		{ "popBrassReedsSectionLegato", "orchestral" },
		{ "popBrassReedsSectionStaccato", "orchestral" },
		{ "popBrassReedsSoloLegato", "orchestral" },
		{ "popBrassReedsSoloStaccato", "orchestral" },
		{ "popBrassSoloLegato", "orchestral" },
		{ "popBrassSoloStaccato", "orchestral" },
		{ "popBrassVintageBrassSectionLegato", "orchestral" },
		{ "popBrassVintageBrassSectionStaccato", "orchestral" },
		{ "popHighStringsLegato", "orchestral" },
		{ "popHighStringsPizzicato", "orchestral" },
		{ "popHighStringsStaccato", "orchestral" },
		{ "popHighStringsTremolo", "orchestral" },
		{ "popLowStringsLegato", "orchestral" },
		{ "popLowStringsPizzicato", "orchestral" },
		{ "popLowStringsStaccato", "orchestral" },
		{ "popLowStringsTremolo", "orchestral" },
		{ "vocalsLaSinger", "vocals" },
		{ "vocalsNaSinger", "vocals" }
	};

    static InstrumentGroup getFXGroupFromLowLevelType (juce::String lowLevelType)
	{
		const auto& cfg = casperaki::mix::MixConfig::instance();
		if (cfg.loaded())
			return getGroup (juce::String (cfg.fxGroup (lowLevelType.toStdString())));

		juce::String fxGroupStr;
		for (auto it = typeMappingTable.begin(); it != typeMappingTable.end(); it++) {
			if (it->first == lowLevelType)
			{
				fxGroupStr = it->second;
                return getGroup (fxGroupStr);
			}
		}

		return InstrumentGroup::drums;
	}

    // Initialize the map inside the class definition
    static inline std::unordered_map<juce::String, FXSendParameters> const instrumentFxSettings = {
        {"fx", {-100.0f, -100.0f, -100.0f}},
        {"kicks", {-100.0f, -100.0f, -100.0f}},
        {"drums", {-25.0f, -100.0f, -100.0f}},
        {"percussion", {-100.0f, -100.0f, -100.0f}},
        {"bass", {-100.0f, -100.0f, -100.0f}},
        {"keys", {-25.0f, -100.0f, -25.0f}},
        {"synths", {-20.0f, -25.0f, -14.0f}},
        {"leadSynths", {-10.0f, -0.0f, -14.0f}},
        {"acousticGuitars", {-25.0f, -25.0f, -25.0f}},
        {"electricGuitars", {-20.0f, -20.0f, -10.0f}},
        {"orchestral", {-100.0f, -100.0f, -100.0f}},
        {"snares", {-100.0f, -100.0f, -100.0f}},
        {"toms", {-100.0f, -100.0f, -100.0f}},
		{"vocals", {-25.0f, -25.0f, -14.0f}}
    };

    // docs/65 — the fxGroup aux-send BASE levels. Reads the shared mix-config when
    // loaded, else the compiled-in instrumentFxSettings map above.
    static FXSendParameters getInstrumentFxSends (juce::String fxGroup)
    {
        const auto& cfg = casperaki::mix::MixConfig::instance();
        if (cfg.loaded())
        {
            auto s = cfg.instrumentFxSends (fxGroup.toStdString());
            return FXSendParameters{ s.reverb, s.delay, s.chorus };
        }
        return instrumentFxSettings.at (fxGroup);
    }

    // docs/65 — the per-lane aux-send levels the engine actually writes: the
    // fxGroup base plus the per-lowLevelType/genre overrides that previously lived
    // inline in Sequencer::prepareInstrumentTracksWithPlugins (the JSON
    // laneSendOverrides). Only used on the config path; the hardcoded send chain
    // remains the fallback when the config is not loaded.
    static FXSendParameters getLaneSends (juce::String fxGroup, juce::String lowLevelType, juce::String genre)
    {
        auto s = casperaki::mix::MixConfig::instance()
                     .laneSends (fxGroup.toStdString(), lowLevelType.toStdString(), genre.toStdString());
        return FXSendParameters{ s.reverb, s.delay, s.chorus };
    }

	enum Send { fxPlateReverb, fxStereoDelay, fxChorus };
	inline static std::unordered_map<juce::String, Send> const fxSendTable =
	{
		{ "fxPlateReverb", Send::fxPlateReverb },
		{ "fxStereoDelay", Send::fxStereoDelay },
		{ "fxChorus", Send::fxChorus },
	};

    static InstrumentGroup getGroup (juce::String fxGroupStr)
	{
        std::unordered_map<juce::String, InstrumentGroup>::const_iterator itg = fxGroupTable.find (fxGroupStr);
		if (itg == fxGroupTable.end())
		{
			DBG("could not find group for " << fxGroupStr);
			//            jassertfalse;
			return drums;
		}

		return itg.operator->()->second;
	}

    static juce::String instrumentGroupToString (InstrumentGroup instrumentGroup)
	{
		if (instrumentGroup == drums) {
			return "drums";
		}

		for (auto it = fxGroupTable.begin(); it != fxGroupTable.end(); it++) {
			if (it->second == instrumentGroup) {
				return it->first;
			}
		}

		jassertfalse;
	}

    juce::String extractFileNameWithType (const juce::String& jucePath)
	{
        juce::File file (jucePath);
		juce::String fileName = file.getFileNameWithoutExtension();
		juce::String fileType = file.getFileExtension();

		return fileName + "." + fileType;
	}

	static tracktion_engine::RackInstance* createRackPluginFromPreset(juce::String presetName, tracktion_engine::Edit* edit, tracktion_engine::Engine* engine, tracktion_engine::Track::Ptr track)
	{
		try
		{
            juce::File vstDirectory;

            //			vstDirectory = juce::File("C:\\Program Files\\Common Files\\VST2");
                   // Get the current executable's directory
            juce::File currentExecutable = juce::File::getSpecialLocation(juce::File::currentApplicationFile);
            juce::String currentDir = currentExecutable.getParentDirectory().getFullPathName();

            //#ifdef JUCE_DEBUG
            //        return "C:\\Program Files\\Common Files\\VST2";
            //#else
            vstDirectory = juce::File (currentDir + "\\ExternalPlugins\\Windows");
            //#endif
			//This is how things are arranged on my systems (Mac & Win) - Abhishek Shivakumar

			juce::String vstDirectoryPath = vstDirectory.getFullPathName();

			juce::String xmlData = PresetManager::getPresetXmlData(presetName);

			auto xmlPreset = AudioPluginUtils::TracktionRack::loadXmlWithPluginFilePaths (xmlData, vstDirectoryPath);

			if (xmlPreset.isNotEmpty())
			{
				DBG ("Loaded XML file contents successfully.");
			}
			else
			{
				throw RackPluginCreationException("Failed to load XML file contents.");
			}

			auto valueTreePreset = juce::ValueTree::fromXml(xmlPreset);

			auto rackPreset = valueTreePreset.getChildWithName("RACK");

			if (rackPreset.isValid())
			{
				DBG ("Loaded RACK preset successfully.");
			}
			else
			{
				throw RackPluginCreationException("Failed to load RACK preset from XML.");
			}

			auto rackType = edit->getRackList().addRackTypeFrom(rackPreset);

			if (rackType != nullptr)
			{
				DBG ("Added rack type from preset.");
			}
			else
			{
				throw RackPluginCreationException ("Failed to add rack type from preset.");
			}

            // Insert the plugin
            auto rackInstanceCreationInfo = tracktion_engine::RackInstance::create(*(rackType.get()));
            auto rackPlugin = dynamic_cast<tracktion_engine::RackInstance*>(edit->getPluginCache().createNewPlugin (rackInstanceCreationInfo).get());
            
			if (rackPlugin != nullptr)
			{
				DBG ("Created rack plugin successfully.");
			}
			else
			{
				throw RackPluginCreationException ("Failed to create rack plugin.");
			}

			return rackPlugin;
		}
		catch (const RackPluginCreationException& e)
		{
			juce::Logger::writeToLog ("RackPluginCreationException occurred: " + juce::String(e.what()));
			return nullptr;
		}
		catch (const std::exception& e)
		{
			juce::Logger::writeToLog("Exception occurred: " + juce::String(e.what()));
			return nullptr;
		}
		catch (...)
		{
			juce::Logger::writeToLog("Unknown exception occurred.");
			return nullptr;
		}
	}

	static double getInstrumentTargetVolume ( juce::String lowLevelType, juce::String genre )
	{
		const auto& cfg = casperaki::mix::MixConfig::instance();
		if (cfg.loaded())
			return cfg.targetVolume (lowLevelType.toStdString(), genre.toStdString());

        if (lowLevelType == "acousticGuitarsNylonMono" && genre == "brightPop") return -3;
        if (lowLevelType == "acousticGuitarsNylonStereo" && genre == "brightPop") return -3;
        if (lowLevelType == "acousticGuitarsSteelMono" && genre == "brightPop") return -3;
        if (lowLevelType == "acousticGuitarsSteelStereo" && genre == "brightPop") return -3;
        if (lowLevelType == "acousticGuitars12StringMono" && genre == "brightPop") return -3;
        if (lowLevelType == "acousticGuitars12StringStereo" && genre == "brightPop") return -3;
        if (lowLevelType == "acousticGuitarsBanjoMono" && genre == "brightPop") return -3;
        if (lowLevelType == "acousticGuitarsBanjoStereo" && genre == "brightPop") return -3;
        if (lowLevelType == "acousticGuitarsMandolineMono" && genre == "brightPop") return -3;
        if (lowLevelType == "acousticGuitarsMandolineStereo" && genre == "brightPop") return -3;
        if (lowLevelType == "acousticGuitarsUkuleleMono" && genre == "brightPop") return -3;
        if (lowLevelType == "acousticGuitarsUkuleleStereo" && genre == "brightPop") return -3;
        
		if (lowLevelType == "acousticGuitarsNylonMono") return -5;
		if (lowLevelType == "acousticGuitarsNylonStereo") return -5;
		if (lowLevelType == "acousticGuitarsSteelMono") return -5;
		if (lowLevelType == "acousticGuitarsSteelStereo") return -5;
		if (lowLevelType == "acousticGuitars12StringMono") return -5;
		if (lowLevelType == "acousticGuitars12StringStereo") return -5;
		if (lowLevelType == "acousticGuitarsBanjoMono") return -5;
		if (lowLevelType == "acousticGuitarsBanjoStereo") return -5;
		if (lowLevelType == "acousticGuitarsMandolineMono") return -5;
		if (lowLevelType == "acousticGuitarsMandolineStereo") return -5;
		if (lowLevelType == "acousticGuitarsUkuleleMono") return -5;
		if (lowLevelType == "acousticGuitarsUkuleleStereo") return -5;

		if (lowLevelType == "bassesAcoustic") return 0;
		if (lowLevelType == "bassesElectric") return 0;
		if (lowLevelType == "bassesSynthSoft") return 0;
		if (lowLevelType == "bassesSynthDistorted") return 0;
		if (lowLevelType == "bassesSynthSub") return 0;
		if (lowLevelType == "bassesSynthPluck") return 0;
		if (lowLevelType == "bassesSynth808") return 0;
		if (lowLevelType == "bassesSynthWobble") return 0;

		if (lowLevelType == "clapsSnapsClapsAcoustic" && genre == "rock") return -12;
		if (lowLevelType == "clapsSnapsClapsAcoustic") return -10;
		if (lowLevelType == "clapsSnapsClapsElectronic" && genre == "rock") return -12;
		if (lowLevelType == "clapsSnapsClapsElectronic") return -10;
		if (lowLevelType == "clapsSnapsClapsPreshifted" && genre == "rock") return -12;
		if (lowLevelType == "clapsSnapsClapsPreshifted") return -10;
		if (lowLevelType == "clapsSnapsSnapsAcoustic" && genre == "rock") return -12;
		if (lowLevelType == "clapsSnapsSnapsAcoustic") return -10;
		if (lowLevelType == "clapsSnapsSnapsElectronic" && genre == "rock") return -12;
		if (lowLevelType == "clapsSnapsSnapsElectronic") return -10;

		if (lowLevelType == "cymbalsCrashHit") return 0;
		if (lowLevelType == "cymbalsElectronic") return 0;
		if (lowLevelType == "cymbalsOrchestral") return 0;
		if (lowLevelType == "cymbalsReverse") return 0;
        if (lowLevelType == "cymbalsRideRim" && genre == "latin") return -21;
        if (lowLevelType == "cymbalsRideRim" && genre == "organicVibes") return -19;
		if (lowLevelType == "cymbalsRideRim" && genre == "ballad") return -15;
		if (lowLevelType == "cymbalsRideRim") return -15;
        if (lowLevelType == "cymbalsRideBell" && genre == "latin") return -21;
		if (lowLevelType == "cymbalsRideBell" && genre == "ballad") return -15;
        if (lowLevelType == "cymbalsRideBell" && genre == "organicVibes") return -19;
		if (lowLevelType == "cymbalsRideBell") return -15;

		if (lowLevelType == "electricGuitarsDominoMono") return -5;
		if (lowLevelType == "electricGuitarsDominoStereo") return -5;
		if (lowLevelType == "electricGuitarsLpChorusMono") return -5;
		if (lowLevelType == "electricGuitarsLpChorusStereo") return -5;
		if (lowLevelType == "electricGuitarsStratDriveMono") return -5;
		if (lowLevelType == "electricGuitarsStratDriveStereo") return -5;
		if (lowLevelType == "electricGuitarsWarmCrunchMono") return -5;
		if (lowLevelType == "electricGuitarsWarmCrunchStereo") return -5;

		//This differs from the legacy app, all lowLevelTypes under fx have been brought down by 10dB, with the exception of the fretnoise
        if (lowLevelType == "fxAtmosphere") return -10;
        if (lowLevelType == "fxDownlifter") return -15;
        if (lowLevelType == "fxFretNoise" && genre == "edm") return 0;
        if (lowLevelType == "fxFretNoise" && genre == "rock") return 0;
        if (lowLevelType == "fxFretNoise") return 0;
        if (lowLevelType == "fxHighImpact") return -10;
        if (lowLevelType == "fxLowImpact") return -10;
        if (lowLevelType == "fxNoiseRise") return -10;
        if (lowLevelType == "fxOther") return -10;
        if (lowLevelType == "fxReverse") return -10;
        if (lowLevelType == "fxTonalReverse") return -10;
        if (lowLevelType == "fxTransition") return -10;
        if (lowLevelType == "fxUplifter") return -10;

        if (lowLevelType == "hiHatsClosedAcoustic" && genre == "urban") return -14;
        if (lowLevelType == "hiHatsClosedAcoustic" && genre == "rock") return -21; //Stefan requested a 6dB decrease on the hiHatsClosedAcoustic
        if (lowLevelType == "hiHatsClosedAcoustic") return -12;
        if (lowLevelType == "hiHatsClosedElectronic" && genre == "edm") return -14;
        if (lowLevelType == "hiHatsClosedElectronic" && genre == "urban") return -12;
        if (lowLevelType == "hiHatsClosedElectronic" && genre == "organicVibes") return -13;
		if (lowLevelType == "hiHatsClosedElectronic") return -10;
        if (lowLevelType == "hiHatsOpenAcoustic" && genre == "rock") return -15;
		if (lowLevelType == "hiHatsOpenAcoustic") return -12;
		if (lowLevelType == "hiHatsOpenElectronic") return -25;

		if (lowLevelType == "keysAcousticPiano" && genre == "ballad") return -4;
		if (lowLevelType == "keysAcousticPiano" && genre == "latin") return -3;
		if (lowLevelType == "keysAcousticPiano" && genre == "edm") return -4;
		if (lowLevelType == "keysAcousticPiano" && genre == "schlager") return -4;
		if (lowLevelType == "keysAcousticPiano" && genre == "organicVibes") return -7;
		if (lowLevelType == "keysAcousticPiano" && genre == "rock") return -8;
		if (lowLevelType == "keysAcousticPiano" && genre == "urban") return -5;
		if (lowLevelType == "keysAcousticPiano") return 0;

		if (lowLevelType == "keysElectronicPiano" && genre == "latin") return -3;
		if (lowLevelType == "keysElectronicPiano" && genre == "edm") return -4;
		if (lowLevelType == "keysElectronicPiano" && genre == "schlager") return -4;
		if (lowLevelType == "keysElectronicPiano" && genre == "organicVibes") return -6;
		if (lowLevelType == "keysElectronicPiano" && genre == "urban") return -9;
		if (lowLevelType == "keysElectronicPiano" && genre == "rock") return -7;
		if (lowLevelType == "keysElectronicPiano" && genre == "urban") return -9;
		if (lowLevelType == "keysElectronicPiano") return 0;

		if (lowLevelType == "keysOrgan") return 0;
		if (lowLevelType == "keysChoir") return 0;

        if (lowLevelType == "kickDrumsAcoustic" && genre == "ballad") return -2;
		if (lowLevelType == "kickDrumsAcoustic") return 0;
        if (lowLevelType == "kickDrumsElectronic" && genre == "urban") return 2;
		if (lowLevelType == "kickDrumsElectronic") return 0;

		if (lowLevelType == "leadSynthsAnalog") return 0;
		if (lowLevelType == "leadSynthsBright") return -5;
		if (lowLevelType == "leadSynthsSoft") return -3;
		if (lowLevelType == "leadSynthsDistorted") return 0;

		if (lowLevelType == "orchestralViolinLegato") return -7;
		if (lowLevelType == "orchestralViolaLegato") return -7;
		if (lowLevelType == "orchestralCelloLegato") return -7;
		if (lowLevelType == "orchestralBassLegato") return -7;
		if (lowLevelType == "orchestralHighStringsTremolo") return -7;
		if (lowLevelType == "orchestralLowStringsTremolo") return -7;
		if (lowLevelType == "orchestralHighStringsStaccato") return -7;
		if (lowLevelType == "orchestralLowStringsStaccato") return -7;
		if (lowLevelType == "orchestralHighStringsPizzicato") return -7;
		if (lowLevelType == "orchestralLowStringsPizzicato") return -7;
		if (lowLevelType == "orchestralViolinSolo") return -7;
		if (lowLevelType == "orchestralViolaSolo") return -7;
		if (lowLevelType == "orchestralCelloSolo") return -7;
		if (lowLevelType == "orchestralBassSolo") return -7;
		if (lowLevelType == "orchestralLowBrassLegato") return -7;
		if (lowLevelType == "orchestralLowBrassStaccato") return -7;
		if (lowLevelType == "orchestralHighBrassLegato") return -7;
		if (lowLevelType == "orchestralHighBrassStaccato") return -7;
		if (lowLevelType == "orchestralHit") return -7;
		if (lowLevelType == "orchestralWoodwindsLegato") return -7;
		if (lowLevelType == "orchestralWoodwindsStaccato") return -7;

		if (lowLevelType == "percussionBreaksBuildups") return 0;
		if (lowLevelType == "percussionBreaksFills") return 5;

        if (lowLevelType == "percussionLoopsAcoustic" && genre == "ballad") return -10;
		if (lowLevelType == "percussionLoopsAcoustic") return -7;
        if (lowLevelType == "percussionLoopsElectronic" && genre == "brightPop") return -5;
		if (lowLevelType == "percussionLoopsElectronic" && genre == "ballad") return -12;
		if (lowLevelType == "percussionLoopsElectronic" && genre == "latin") return 0;
        if (lowLevelType == "percussionLoopsElectronic" && genre == "edm") return -8;
		if (lowLevelType == "percussionLoopsElectronic") return -2.5;

		if (lowLevelType == "percussionMiscAcousticHigh") return 0;
		if (lowLevelType == "percussionMiscAcousticLow") return 0;
		if (lowLevelType == "percussionMiscElectronicHigh") return 0;
		if (lowLevelType == "percussionMiscElectronicLow") return 0;

		if (lowLevelType == "percussionMiscVocalShout") return 0;

		if (lowLevelType == "popBrassBrightBrassSectionLegato") return 0;
		if (lowLevelType == "popBrassBrightBrassSectionStaccato") return 0;
		if (lowLevelType == "popBrassReedsSectionLegato") return 0;
		if (lowLevelType == "popBrassReedsSectionStaccato") return 0;
		if (lowLevelType == "popBrassReedsSoloLegato") return 0;
		if (lowLevelType == "popBrassReedsSoloStaccato") return 0;
		if (lowLevelType == "popBrassSoloLegato") return 0;
		if (lowLevelType == "popBrassSoloStaccato") return 0;
		if (lowLevelType == "popBrassVintageBrassSectionLegato") return 0;
		if (lowLevelType == "popBrassVintageBrassSectionStaccato") return 0;
		if (lowLevelType == "popHighStringsLegato") return -7;
		if (lowLevelType == "popHighStringsPizzicato" && genre == "organicVibes" ) return -10;
		if (lowLevelType == "popHighStringsPizzicato" && genre == "urban" ) return -12.5;
		if (lowLevelType == "popHighStringsPizzicato") return -7;
		if (lowLevelType == "popHighStringsStaccato" && genre == "organicVibes") return -10;
		if (lowLevelType == "popHighStringsStaccato" && genre == "urban") return -12.5;
		if (lowLevelType == "popHighStringsStaccato") return -7;
		if (lowLevelType == "popHighStringsTremolo") return -17;
		if (lowLevelType == "popLowStringsLegato") return -7;
		if (lowLevelType == "popLowStringsPizzicato") return -7;
		if (lowLevelType == "popLowStringsStaccato") return -7;
		if (lowLevelType == "popLowStringsTremolo") return -7;

		if (lowLevelType == "shakersAcoustic") return -10;
		if (lowLevelType == "shakersElectronic") return -10;

		if (lowLevelType == "snareDrumsAcoustic") return 0 - 3; //Stefan requested 3dB for acoustic snares and toms
		if (lowLevelType == "snareDrumsElectronic" && genre == "organicVibes") return -9;
		if (lowLevelType == "snareDrumsElectronic") return -6;

        if (lowLevelType == "synthsSoftPad" && (genre == "ballad" || genre == "brightPop" || genre == "rock")) return -21;
		if (lowLevelType == "synthsSoftPad") return -17;
        if (lowLevelType == "synthsBrightPad" && (genre == "ballad" || genre == "brightPop" || genre == "rock")) return -21;
		if (lowLevelType == "synthsBrightPad") return -17;

		if (lowLevelType == "synthsArpeggiated") return 0;

        if (lowLevelType == "synthsPlucked" && genre == "latin") return -3;
		if (lowLevelType == "synthsPlucked" && genre == "urban") return -2;
		if (lowLevelType == "synthsPlucked") return -7;

        if (lowLevelType == "tomsAcoustic" && genre == "rock") return -3;
		if (lowLevelType == "tomsAcoustic") return 0; //Stefan requested 3dB for acoustic snares and toms
		if (lowLevelType == "tomsElectronic") return -17;

		if (lowLevelType == "vocalsLaSinger") return 0;
		if (lowLevelType == "vocalsNaSinger") return 0;

		return 0;
	}
private:
};

