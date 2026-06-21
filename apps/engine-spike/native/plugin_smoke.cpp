// docs/57b — Plugin-hosting smoke binary.
//
// Constructs a default tracktion::Engine, instantiates the 6 Airwindows
// plugins that Tracktion 3.2 ships as built-in types and that the legacy
// rack chain references, runs a known noise buffer through Pyewacket, and
// reports the plugin-format list registered by AudioPluginFormatManager
// under the spike build's plugin-host flag set.
//
// Independent JUCEApplication — does NOT link CasperakiEngine or touch the
// production render path. See docs/57b for the rationale.

#include <iostream>
#include <sstream>
#include <vector>

#include <JuceHeader.h>

namespace te = tracktion::engine;

namespace {

std::string jsonEscape (const std::string& s)
{
    std::string out;
    out.reserve (s.size() + 2);
    for (char c : s)
    {
        switch (c)
        {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:   out += c;
        }
    }
    return out;
}

struct LegacyPluginEntry
{
    const char* legacyName;
    const char* xmlTypeName;
};

// The 6 legacy rack XML plugins that overlap Tracktion 3.2's in-tree
// AirWindows snapshot. xmlTypeNames pulled from
// tracktion_AirWindows{1,2,3}.cpp. The class names are
// AirWindowsPyewacket / AirWindowsEQ / AirWindowsLogical4 /
// AirWindowsNCSeventeen (note rename) / AirWindowsThunder /
// AirWindowsADClip7.
constexpr LegacyPluginEntry kLegacyOverlap[] = {
    { "Pyewacket", "airwindows_pyewacket" },
    { "EQ",        "airwindows_eq" },
    { "Logical4",  "airwindows_logical4" },
    { "NC-17",     "airwindows_nc17" },
    { "Thunder",   "airwindows_thunder" },
    { "ADClip7",   "airwindows_adclip7" },
};
constexpr int kLegacyOverlapCount = static_cast<int> (sizeof (kLegacyOverlap)
                                                     / sizeof (kLegacyOverlap[0]));

} // namespace

class SmokeApp : public juce::JUCEApplication, private juce::Timer
{
public:
    const juce::String getApplicationName() override    { return "CasperakiPluginSmoke"; }
    const juce::String getApplicationVersion() override { return "0.1.0"; }
    bool moreThanOneInstanceAllowed() override          { return false; }

    void initialise (const juce::String& cmdLine) override
    {
        std::setvbuf (stdout, nullptr, _IOLBF, 0);
        std::setvbuf (stderr, nullptr, _IOLBF, 0);

        // Parse CLI args. --scan-external enables JUCE's VST3/LV2 scanner
        // path against ~/.vst3 + ~/.lv2 and dumps each scanned plugin's
        // parameter + program list (used by 57c to capture the
        // Airwindows Consolidated algorithm-name mapping).
        scanExternal = juce::StringArray::fromTokens (cmdLine, true)
                          .contains ("--scan-external", false);

        // Defer the actual work to the next message-loop tick so JUCEApplication
        // is fully set up before we touch tracktion (which assumes a live message
        // manager).
        startTimer (1);
    }

    bool scanExternal = false;

    void shutdown() override {}

    void timerCallback() override
    {
        stopTimer();
        runSmoke();
        quit();
    }

private:
    void runSmoke()
    {
        std::ostringstream json;
        json << "{\n";

        // 1. Plugin format list (post JUCE_PLUGINHOST_* flag set).
        juce::AudioPluginFormatManager fmtMgr;
        fmtMgr.addDefaultFormats();
        std::vector<std::string> formatNames;
        for (int i = 0; i < fmtMgr.getNumFormats(); ++i)
            formatNames.push_back (fmtMgr.getFormat (i)->getName().toStdString());

        json << "  \"formats\": [";
        for (size_t i = 0; i < formatNames.size(); ++i)
        {
            if (i) json << ", ";
            json << "\"" << jsonEscape (formatNames[i]) << "\"";
        }
        json << "],\n";

        // 2. Engine + Edit so the plugin cache is available.
        std::unique_ptr<te::Engine> engine;
        try
        {
            engine = std::make_unique<te::Engine> (juce::String ("CasperakiPluginSmoke"));
        }
        catch (const std::exception& e)
        {
            json << "  \"errors\": [\"engine ctor failed: "
                 << jsonEscape (e.what()) << "\"]\n}\n";
            std::cout << json.str();
            std::cerr << "[plugin-smoke] engine ctor failed: " << e.what() << "\n";
            setApplicationReturnValue (2);
            return;
        }

        // PluginManager::initialise() populates builtInTypes; without it,
        // createNewPlugin(xmlTypeName, …) returns null. AirWindows are
        // registered separately and only when TRACKTION_AIR_WINDOWS is set.
        engine->getPluginManager().initialise();
       #if TRACKTION_AIR_WINDOWS
        engine->getPluginManager().initialiseAirWindows();
       #endif

        auto edit = te::Edit::createSingleTrackEdit (*engine);
        if (edit == nullptr)
        {
            json << "  \"errors\": [\"createSingleTrackEdit returned nullptr\"]\n}\n";
            std::cout << json.str();
            std::cerr << "[plugin-smoke] createSingleTrackEdit returned nullptr\n";
            setApplicationReturnValue (3);
            return;
        }

        // 3. Instantiate each Tracktion-internal Airwindows plugin that the
        // legacy rack XMLs reference.
        json << "  \"internalAirWindows\": [\n";
        int instantiated = 0;
        te::Plugin::Ptr pyewacketPlugin;
        for (int i = 0; i < kLegacyOverlapCount; ++i)
        {
            const auto& entry = kLegacyOverlap[i];
            auto plugin = edit->getPluginCache().createNewPlugin (
                juce::String (entry.xmlTypeName), {});
            const bool ok = plugin.get() != nullptr;
            int numParams = 0;
            std::string pluginDisplayName;
            if (ok)
            {
                ++instantiated;
                numParams = plugin->getNumAutomatableParameters();
                pluginDisplayName = plugin->getName().toStdString();
            }

            json << "    { \"legacy\": \"" << jsonEscape (entry.legacyName)
                 << "\", \"xmlTypeName\": \"" << jsonEscape (entry.xmlTypeName)
                 << "\", \"displayName\": \"" << jsonEscape (pluginDisplayName)
                 << "\", \"instantiated\": " << (ok ? "true" : "false")
                 << ", \"numParams\": " << numParams << " }"
                 << (i + 1 < kLegacyOverlapCount ? "," : "") << "\n";

            if (ok && std::string (entry.xmlTypeName) == "airwindows_pyewacket")
                pyewacketPlugin = plugin;
        }
        json << "  ],\n";

        // 4. Process a deterministic noise buffer through Pyewacket and confirm
        // the output diverges from the input. White noise feed at 0.5 amplitude.
        // Pyewacket is a clipper-style dynamics processor with strong character
        // at defaults — pass-through would only happen if AirWindowsPlugin is
        // silently bypassed (e.g. wet=0 or impl=nullptr).
        struct PyewacketResult
        {
            bool ran = false;
            bool diverged = false;
            float inRms = 0.0f;
            float outRms = 0.0f;
            int samples = 0;
        } pyewacketRms;

        if (pyewacketPlugin != nullptr)
        {
            constexpr int kSamples = 4096;
            constexpr double kSampleRate = 44100.0;

            juce::AudioBuffer<float> buf (2, kSamples);
            juce::Random rng (42);
            for (int ch = 0; ch < 2; ++ch)
                for (int i = 0; i < kSamples; ++i)
                    buf.setSample (ch, i, (rng.nextFloat() * 2.0f - 1.0f) * 0.5f);

            juce::AudioBuffer<float> inputCopy;
            inputCopy.makeCopyOf (buf);

            pyewacketRms.inRms = buf.getRMSLevel (0, 0, kSamples);

            te::PluginInitialisationInfo init {
                tracktion::TimePosition::fromSeconds (0.0),
                kSampleRate,
                kSamples
            };
            pyewacketPlugin->baseClassInitialise (init);

            te::MidiMessageArray midi;
            te::PluginRenderContext ctx (
                &buf, juce::AudioChannelSet::stereo(),
                0, kSamples,
                &midi, 0.0,
                tracktion::TimeRange {
                    tracktion::TimePosition::fromSeconds (0.0),
                    tracktion::TimePosition::fromSamples (kSamples, kSampleRate)
                },
                /*playing*/ true,
                /*scrubbing*/ false,
                /*rendering*/ true,
                /*allowBypassedProcessing*/ false);

            pyewacketPlugin->applyToBuffer (ctx);

            pyewacketRms.outRms = buf.getRMSLevel (0, 0, kSamples);
            pyewacketRms.samples = kSamples;

            bool diverged = false;
            for (int ch = 0; ch < 2 && ! diverged; ++ch)
            {
                auto* a = inputCopy.getReadPointer (ch);
                auto* b = buf.getReadPointer (ch);
                for (int i = 0; i < kSamples; ++i)
                {
                    if (a[i] != b[i]) { diverged = true; break; }
                }
            }
            pyewacketRms.diverged = diverged;
            pyewacketRms.ran = true;
        }

        const float ratio = (pyewacketRms.inRms > 0.0f)
            ? pyewacketRms.outRms / pyewacketRms.inRms
            : 0.0f;

        json << "  \"pyewacket\": { "
             << "\"ran\": "       << (pyewacketRms.ran ? "true" : "false")
             << ", \"diverged\": " << (pyewacketRms.diverged ? "true" : "false")
             << ", \"inRms\": "    << pyewacketRms.inRms
             << ", \"outRms\": "   << pyewacketRms.outRms
             << ", \"ratio\": "    << ratio
             << ", \"samples\": "  << pyewacketRms.samples
             << " },\n";

        // 5. VST3 / LV2 inventory. Without --scan-external we do a file
        // listing only (cheap, side-effect free). With --scan-external we
        // load each bundle via JUCE's scanner and dump the parameter list
        // (used by 57c to map Airwindows Consolidated's algorithm names to
        // their VST3 program / parameter mechanism).
        const auto home = juce::File::getSpecialLocation (juce::File::userHomeDirectory);
        const auto vst3Dir = home.getChildFile (".vst3");
        const auto lv2Dir  = home.getChildFile (".lv2");
        const auto vst2Dir = home.getChildFile (".vst");

        auto listDir = [&] (const juce::File& dir) {
            json << "[";
            if (dir.isDirectory())
            {
                juce::Array<juce::File> entries;
                dir.findChildFiles (entries,
                                    juce::File::findFilesAndDirectories
                                      | juce::File::ignoreHiddenFiles,
                                    /*searchRecursively*/ false);
                for (int i = 0; i < entries.size(); ++i)
                {
                    if (i) json << ", ";
                    json << "\"" << jsonEscape (entries[i].getFileName().toStdString()) << "\"";
                }
            }
            json << "]";
        };

        json << "  \"vst3Dir\": \"" << jsonEscape (vst3Dir.getFullPathName().toStdString())
             << "\", \"vst3DirExists\": " << (vst3Dir.isDirectory() ? "true" : "false")
             << ", \"vst3DirContents\": ";
        listDir (vst3Dir);
        json << ",\n";

        json << "  \"lv2Dir\": \"" << jsonEscape (lv2Dir.getFullPathName().toStdString())
             << "\", \"lv2DirExists\": " << (lv2Dir.isDirectory() ? "true" : "false")
             << ", \"lv2DirContents\": ";
        listDir (lv2Dir);
        json << ",\n";

        // --scan-external: walk each bundle in ~/.vst3 and ~/.lv2 via JUCE's
        // format scanners. For each plugin description we record vendor,
        // category, file path, program list, and parameter list. Algorithm
        // selectors in single-binary "switcher" plugins (e.g. Airwindows
        // Consolidated) typically surface either as VST3 programs (selected
        // via setCurrentProgram) or as a discrete parameter whose valueStrings
        // list every option — the JSON dump lets the next slice decide which.
        json << "  \"scannedExternal\": " << (scanExternal ? "true" : "false") << ",\n";
        json << "  \"externalPlugins\": [";

        if (scanExternal)
        {
            int dumped = 0;

            auto dumpBundle = [&] (juce::AudioPluginFormat& fmt, const juce::File& bundle) {
                juce::OwnedArray<juce::PluginDescription> descs;
                fmt.findAllTypesForFile (descs, bundle.getFullPathName());
                for (auto* desc : descs)
                {
                    juce::String err;
                    auto inst = fmt.createInstanceFromDescription (
                        *desc, 44100.0, 512, err);

                    if (dumped > 0) json << ",";
                    json << "\n    {";
                    json << " \"format\": \"" << jsonEscape (fmt.getName().toStdString()) << "\"";
                    json << ", \"bundle\": \"" << jsonEscape (bundle.getFileName().toStdString()) << "\"";
                    json << ", \"name\": \"" << jsonEscape (desc->name.toStdString()) << "\"";
                    json << ", \"vendor\": \"" << jsonEscape (desc->manufacturerName.toStdString()) << "\"";
                    json << ", \"category\": \"" << jsonEscape (desc->category.toStdString()) << "\"";
                    json << ", \"version\": \"" << jsonEscape (desc->version.toStdString()) << "\"";
                    json << ", \"loaded\": " << (inst != nullptr ? "true" : "false");
                    if (inst == nullptr)
                    {
                        json << ", \"loadError\": \"" << jsonEscape (err.toStdString()) << "\"";
                        json << " }";
                        ++dumped;
                        continue;
                    }

                    json << ", \"numPrograms\": " << inst->getNumPrograms();
                    json << ", \"programs\": [";
                    for (int p = 0; p < std::min (inst->getNumPrograms(), 512); ++p)
                    {
                        if (p) json << ",";
                        json << " \"" << jsonEscape (inst->getProgramName (p).toStdString()) << "\"";
                    }
                    json << "]";

                    const auto& params = inst->getParameters();
                    json << ", \"numParameters\": " << params.size();
                    json << ", \"parameters\": [";
                    for (int p = 0; p < params.size(); ++p)
                    {
                        if (p) json << ",";
                        auto* param = params[p];
                        json << "\n      { \"index\": " << p
                             << ", \"name\": \"" << jsonEscape (param->getName (64).toStdString()) << "\""
                             << ", \"label\": \"" << jsonEscape (param->getLabel().toStdString()) << "\""
                             << ", \"defaultValue\": " << param->getDefaultValue()
                             << ", \"numSteps\": " << param->getNumSteps()
                             << ", \"isDiscrete\": " << (param->isDiscrete() ? "true" : "false");

                        // For discrete-valued parameters, dump the value-name list —
                        // that's where a single-binary "switcher" plugin typically
                        // surfaces its algorithm-name set.
                        if (param->isDiscrete() && param->getNumSteps() < 1024)
                        {
                            json << ", \"valueStrings\": [";
                            const int n = param->getNumSteps();
                            for (int s = 0; s < n; ++s)
                            {
                                if (s) json << ",";
                                const float v = n > 1 ? float (s) / float (n - 1) : 0.0f;
                                json << " \"" << jsonEscape (param->getText (v, 64).toStdString()) << "\"";
                            }
                            json << "]";
                        }

                        json << " }";
                    }
                    json << " ]";
                    json << " }";
                    ++dumped;
                }
            };

           #if JUCE_PLUGINHOST_VST3
            {
                juce::VST3PluginFormat vst3;
                if (vst3Dir.isDirectory())
                {
                    juce::Array<juce::File> entries;
                    vst3Dir.findChildFiles (entries,
                                            juce::File::findFilesAndDirectories
                                              | juce::File::ignoreHiddenFiles,
                                            false);
                    for (auto& e : entries)
                        if (e.getFileExtension() == ".vst3")
                            dumpBundle (vst3, e);
                }
            }
           #endif
           #if JUCE_PLUGINHOST_LV2
            {
                juce::LV2PluginFormat lv2;
                if (lv2Dir.isDirectory())
                {
                    juce::Array<juce::File> entries;
                    lv2Dir.findChildFiles (entries,
                                           juce::File::findFilesAndDirectories
                                             | juce::File::ignoreHiddenFiles,
                                           false);
                    for (auto& e : entries)
                        if (e.getFileExtension() == ".lv2")
                            dumpBundle (lv2, e);
                }
            }
           #endif
           #if JUCE_PLUGINHOST_VST
            // VST2 scan path — recursive walk under ~/.vst because yabridge
            // proxies live in ~/.vst/yabridge/<name>.so. Looks for .so files
            // (Linux VST2) only.
            {
                juce::VSTPluginFormat vst2;
                if (vst2Dir.isDirectory())
                {
                    juce::Array<juce::File> entries;
                    vst2Dir.findChildFiles (entries,
                                            juce::File::findFiles
                                              | juce::File::ignoreHiddenFiles,
                                            /*searchRecursively*/ true,
                                            "*.so");
                    for (auto& e : entries)
                        dumpBundle (vst2, e);
                }
            }
           #endif
        }

        json << "\n  ],\n";

        // Probe Airwindows Consolidated's algorithm-selection mechanism by
        // round-tripping a state blob with currentProcessorName="Console8SubIn"
        // (the most-referenced post-snapshot legacy plugin). The state-blob
        // layout is from src-juce/AWConsolidatedProcessor.cpp::getStateInformation.
        // If this works, the rack-XML remap design is mechanically proven.
        json << "  \"consolidatedAlgoProbe\": ";
       #if JUCE_PLUGINHOST_VST3
        if (scanExternal)
        {
            juce::VST3PluginFormat vst3;
            const auto bundle = vst3Dir.getChildFile ("Airwindows Consolidated.vst3");
            juce::OwnedArray<juce::PluginDescription> descs;
            vst3.findAllTypesForFile (descs, bundle.getFullPathName());

            if (descs.isEmpty())
            {
                json << "{ \"ran\": false, \"reason\": \"Consolidated.vst3 not found\" },\n";
            }
            else
            {
                juce::String err;
                auto inst = vst3.createInstanceFromDescription (
                    *descs.getFirst(), 44100.0, 512, err);
                if (inst == nullptr)
                {
                    json << "{ \"ran\": false, \"reason\": \"load failed: "
                         << jsonEscape (err.toStdString()) << "\" },\n";
                }
                else
                {
                    const juce::String targetAlgo = "Console8SubIn";

                    juce::XmlElement xml ("awconsolidated");
                    xml.setAttribute ("streamingVersion", (int) 8524);
                    xml.setAttribute ("currentProcessorName", targetAlgo);
                    for (int i = 0; i < 10; ++i)
                        xml.setAttribute (juce::String ("awp_") + juce::String (i), 0.5);
                    xml.setAttribute ("inlev", 0.5);
                    xml.setAttribute ("outlev", 0.5);
                    xml.setAttribute ("monoBehaviour", 0.0);

                    // Raw bytes of the awconsolidated XML — this is what
                    // AWConsolidatedAudioProcessor::getStateInformation writes
                    // and what setStateInformation expects. But JUCE's VST3
                    // host wrapper expects those bytes to be base64-encoded
                    // inside <VST3PluginState><IComponent>...</IComponent></VST3PluginState>.
                    juce::MemoryBlock innerBlob;
                    juce::AudioProcessor::copyXmlToBinary (xml, innerBlob);

                    juce::XmlElement wrapper ("VST3PluginState");
                    auto* ic = wrapper.createNewChildElement ("IComponent");
                    ic->addTextElement (innerBlob.toBase64Encoding());

                    juce::MemoryBlock blob;
                    juce::AudioProcessor::copyXmlToBinary (wrapper, blob);
                    inst->setStateInformation (blob.getData(), (int) blob.getSize());

                    juce::MemoryBlock readBack;
                    inst->getStateInformation (readBack);
                    auto readXml = juce::AudioProcessor::getXmlFromBinary (
                        readBack.getData(), (int) readBack.getSize());

                    // Surface the wrapper structure: tag, attribute names,
                    // child-element tags. The Airwindows state likely lives
                    // nested inside JUCE's VST3PluginState envelope.
                    juce::String readXmlTag, readXmlAttrs, readXmlChildren, readXmlDump;
                    juce::String selectedAlgo;
                    if (readXml != nullptr)
                    {
                        readXmlTag = readXml->getTagName();
                        readXmlDump = readXml->toString().substring (0, 1500);
                        for (int a = 0; a < readXml->getNumAttributes(); ++a)
                        {
                            if (a > 0) readXmlAttrs += ",";
                            readXmlAttrs += readXml->getAttributeName (a);
                        }
                        for (auto* child : readXml->getChildIterator())
                        {
                            if (readXmlChildren.isNotEmpty()) readXmlChildren += ",";
                            readXmlChildren += child->getTagName();
                        }

                        // The read-back has shape:
                        //   <VST3PluginState>
                        //     <IComponent>base64(awconsolidated-bytes)</IComponent>
                        //   </VST3PluginState>
                        // To find the algorithm, decode the IComponent base64,
                        // parse the resulting bytes as a JUCE-binary XML, and
                        // read currentProcessorName from the awconsolidated root.
                        if (auto* icElem = readXml->getChildByName ("IComponent"))
                        {
                            const auto b64 = icElem->getAllSubText();
                            juce::MemoryBlock inner;
                            if (inner.fromBase64Encoding (b64))
                            {
                                if (auto innerXml = juce::AudioProcessor::getXmlFromBinary (
                                        inner.getData(), (int) inner.getSize()))
                                {
                                    if (innerXml->hasAttribute ("currentProcessorName"))
                                        selectedAlgo = innerXml->getStringAttribute ("currentProcessorName");
                                }
                            }
                        }
                    }

                    json << "{ \"ran\": true"
                         << ", \"targetAlgo\": \"" << jsonEscape (targetAlgo.toStdString()) << "\""
                         << ", \"selectedAlgo\": \"" << jsonEscape (selectedAlgo.toStdString()) << "\""
                         << ", \"matched\": " << (selectedAlgo == targetAlgo ? "true" : "false")
                         << ", \"writtenBlobSize\": " << blob.getSize()
                         << ", \"readBlobSize\": " << readBack.getSize()
                         << ", \"readBackRootTag\": \"" << jsonEscape (readXmlTag.toStdString()) << "\""
                         << ", \"readBackRootAttrs\": \"" << jsonEscape (readXmlAttrs.toStdString()) << "\""
                         << ", \"readBackChildren\": \"" << jsonEscape (readXmlChildren.toStdString()) << "\""
                         << ", \"readBackXmlDump\": \"" << jsonEscape (readXmlDump.toStdString()) << "\""
                         << " },\n";
                }
            }
        }
        else
        {
            json << "{ \"ran\": false, \"reason\": \"--scan-external not set\" },\n";
        }
       #else
        json << "{ \"ran\": false, \"reason\": \"VST3 disabled at compile time\" },\n";
       #endif

        json << "  \"summary\": { \"instantiated\": " << instantiated
             << ", \"expected\": " << kLegacyOverlapCount << " },\n";
        json << "  \"errors\": []\n}\n";

        std::cout << json.str();

        // Human summary on stderr.
        std::cerr << "[plugin-smoke] formats=";
        for (size_t i = 0; i < formatNames.size(); ++i)
        {
            if (i) std::cerr << ",";
            std::cerr << formatNames[i];
        }
        if (formatNames.empty()) std::cerr << "(none)";
        std::cerr << " internal=" << instantiated << "/" << kLegacyOverlapCount;
        if (pyewacketRms.ran)
        {
            std::cerr << " pyewacket=" << (pyewacketRms.diverged ? "diverged" : "BYPASSED")
                      << " ratio=" << ratio;
        }
        std::cerr << "\n";

        const bool pass = instantiated == kLegacyOverlapCount
                          && pyewacketRms.ran
                          && pyewacketRms.diverged;
        setApplicationReturnValue (pass ? 0 : 1);
    }
};

START_JUCE_APPLICATION (SmokeApp)
