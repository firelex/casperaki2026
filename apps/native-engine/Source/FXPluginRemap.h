// FXPluginRemap.h — docs/57d (Linux rack-XML plugin remap).
//
// The legacy rack-preset XMLs in PresetManager.h reference 16 unique
// external VST2 plugins (airwindows family + SimpleSide + Valhalla).
// On Mac/Windows the load path is the legacy FX::transformVSTPath that
// rebases the filename onto ExternalPlugins/Mac or ExternalPlugins/Windows.
// On Linux there is no ExternalPlugins/Linux dir and none of those .vst /
// .dll binaries are loadable.
//
// This header provides the LINUX-ONLY remap that translates each legacy
// PLUGIN reference into one of three destinations:
//
//   - Tracktion-internal AirWindows xmlTypeName (no external file) for the
//     6 plugins that overlap Tracktion 3.2's in-tree snapshot
//     (Pyewacket / EQ / Logical4 / NC-17 / Thunder / ADClip7).
//   - Airwindows Consolidated VST3 + an algorithm-selecting state blob,
//     for the 9 post-snapshot airwindows plugins
//     (Console8Sub/Buss In/Out / kPlateA / kPlateD / TexturizeMS /
//     StereoChorus / Huge / Air2). State-blob shape proven in the smoke
//     binary (apps/engine-spike/native/plugin_smoke.cpp::runSmoke).
//   - In-tree Casperaki FX plugins (no external file) for SimpleSide and
//     ValhallaFreqEcho. These two external VSTs are RETIRED (docs/63 §6):
//     SimpleSide (GPLv3) and ValhallaFreqEcho (proprietary, previously
//     Wine/yabridge-bridged — the source of the multi-hour teardown hang)
//     are now reimplemented as portable DSP shared with the WASM render
//     engine, wrapped by CasperakiSimpleSidePlugin / CasperakiFreqShiftEchoPlugin
//     (Source/casperaki_fx/). The legacy preset state is decoded here into
//     the `casperakiFxParams` attribute the wrappers read.
//
// See docs/57c for the inventory + decision background, docs/57d for the
// slice plan, and docs/63 §6 for the FX-data + Valhalla/SimpleSide retirement.

#pragma once

#include <JuceHeader.h>
#include <unordered_map>
#include <cstring>
#include <string>

namespace fx_remap {

namespace ids {
    inline static const juce::Identifier kPLUGIN ("PLUGIN");
    inline static const juce::Identifier kType   ("type");
    inline static const juce::Identifier kFile   ("filename");
    inline static const juce::Identifier kState  ("state");
}

// Strip path + extension + "64" suffix from a legacy filename so we get
// the canonical plugin name (e.g. "C:\Program Files\…\Console8SubIn64.dll"
// → "Console8SubIn"). Both '\' and '/' separators handled.
inline juce::String legacyBasename (const juce::String& path)
{
    auto stem = path.fromLastOccurrenceOf ("\\", false, false)
                    .fromLastOccurrenceOf ("/",  false, false);

    // Drop extension.
    stem = stem.upToLastOccurrenceOf (".", false, false);

    // Drop common 64-bit suffixes used in legacy Windows DLL naming.
    if (stem.endsWith ("64"))           stem = stem.dropLastCharacters (2);
    if (stem.endsWith ("_x"))           stem = stem.dropLastCharacters (2);

    return stem;
}

// Legacy plugin basename → Tracktion-internal AirWindows xmlTypeName.
// The 6 plugins that overlap Tracktion 3.2's in-tree AirWindows snapshot.
// xmlTypeNames verified live in the 57b smoke binary's
// `internalAirWindows` JSON output.
inline const std::unordered_map<juce::String, juce::String>&
legacyToTracktionInternal()
{
    static const std::unordered_map<juce::String, juce::String> map = {
        // 6 plugins from Tracktion's own AIRWINDOWSPLUGIN snapshot.
        { "Pyewacket", "airwindows_pyewacket" },
        { "EQ",        "airwindows_eq" },
        { "Logical4",  "airwindows_logical4" },
        { "NC-17",     "airwindows_nc17" },
        { "Thunder",   "airwindows_thunder" },
        { "ADClip7",   "airwindows_adclip7" },

        // 10 plugins ported in casperaki_engine/Source/airwindows_extras/.
        // Registered via casperaki::airwindows_extras::registerCasperakiAirwindowsExtras
        // at engine startup. Source bit-identical to the legacy Windows DLLs
        // (Chris Johnson's MIT-licensed Linux VST tree), so the kState chunk
        // deserialises with no translation.
        { "Console8SubIn",   "airwindows_console8_sub_in"   },
        { "Console8SubOut",  "airwindows_console8_sub_out"  },
        { "Console8BussIn",  "airwindows_console8_buss_in"  },
        { "Console8BussOut", "airwindows_console8_buss_out" },
        { "kPlateA",         "airwindows_kplate_a"          },
        { "kPlateD",         "airwindows_kplate_d"          },
        { "TexturizeMS",     "airwindows_texturizems"       },
        { "StereoChorus",    "airwindows_stereochorus"      },
        { "Huge",            "airwindows_huge"              },
        { "Air2",            "airwindows_air2"              },
    };
    return map;
}

// Retained as fallback if the airwindows_extras registration ever fails
// (e.g. a debug build without TRACKTION_AIR_WINDOWS) — currently unused
// because all 10 entries moved into legacyToTracktionInternal() above.
inline const std::unordered_map<juce::String, juce::String>&
legacyToConsolidatedAlgorithm()
{
    static const std::unordered_map<juce::String, juce::String> map = {};
    return map;
}

inline juce::String getConsolidatedVst3Path()
{
    const auto p = juce::File::getSpecialLocation (juce::File::userHomeDirectory)
        .getChildFile (".vst3")
        .getChildFile ("Airwindows Consolidated.vst3")
        .getFullPathName();
    return p;
}

// xmlTypeName of the in-tree replacement plugins. MUST match
// CasperakiFxPlugins.cpp's CasperakiSimpleSidePlugin / CasperakiFreqShiftEchoPlugin.
inline static const char* kCasperakiSimpleSideType    = "casperaki_simpleside";
inline static const char* kCasperakiFreqShiftEchoType = "casperaki_freqshiftecho";

// The legacy plugin `state="<size>.<base64>"` is a JUCE MemoryBlock (its
// toBase64Encoding format). JUCE's fromBase64Encoding round-trips it to the raw
// bytes: a 160-byte FXB ("CcnK"/"FBCh") header followed by the inner VST chunk.
constexpr size_t kFXBHeaderSize = 160;

inline bool decodeFxbBlock (const juce::String& legacyState, juce::MemoryBlock& mb)
{
    if (legacyState.isEmpty() || ! mb.fromBase64Encoding (legacyState))
        return false;
    return mb.getSize() > kFXBHeaderSize;
}

// SimpleSide state isn't AirWindows-float: the inner chunk is 2 little-endian
// doubles (mix, rateValue) then (x,y,rawExp) float triples for the curve points
// (mirrors extract-rack-data.mjs::decodeSimpleSide). Emit the flat param list
// CasperakiSimpleSidePlugin / SimpleSideImpl::setParam expects, space-separated.
inline juce::String decodeSimpleSideParams (const juce::String& legacyState)
{
    juce::MemoryBlock mb;
    if (! decodeFxbBlock (legacyState, mb))
        return {};

    const auto* body = static_cast<const uint8_t*> (mb.getData()) + kFXBHeaderSize;
    const size_t bodySize = mb.getSize() - kFXBHeaderSize;
    if (bodySize < 16)
        return {};

    auto rdDouble = [] (const uint8_t* p) { double d; std::memcpy (&d, p, sizeof d); return d; };
    auto rdFloat  = [] (const uint8_t* p) { float  f; std::memcpy (&f, p, sizeof f); return f; };

    juce::StringArray toks;
    toks.add (juce::String (rdDouble (body),     8));
    toks.add (juce::String (rdDouble (body + 8), 8));
    for (size_t off = 16; off + 12 <= bodySize; off += 12)
    {
        toks.add (juce::String (rdFloat (body + off),     8));
        toks.add (juce::String (rdFloat (body + off + 4), 8));
        toks.add (juce::String (rdFloat (body + off + 8), 8));
    }
    return toks.joinIntoString (" ");
}

// ValhallaFreqEcho state is FXB-wrapped XML, NOT opaque (docs/63 §6): the inner
// chunk contains <MYPLUGINSETTINGS wetDryMix shift delay sync feedback lowCut
// highCut/>. Pull the six knobs the FreqShiftEcho reimplementation matches
// (order = CasperakiFreqShiftEchoPlugin / FreqShiftEchoImpl::setParam).
inline juce::String decodeValhallaParams (const juce::String& legacyState)
{
    juce::MemoryBlock mb;
    if (legacyState.isEmpty() || ! mb.fromBase64Encoding (legacyState))
        return {};

    // The bytes are FXB header + ASCII XML; treat as a raw byte string and pull
    // each key="value" (the binary header has no key="…" patterns to collide).
    const std::string s (static_cast<const char*> (mb.getData()), mb.getSize());

    auto getAttr = [&s] (const char* key) -> juce::String
    {
        const std::string pat = std::string (key) + "=\"";
        const auto p = s.find (pat);
        if (p == std::string::npos)
            return "0";
        const auto start = p + pat.size();
        const auto end = s.find ('"', start);
        if (end == std::string::npos)
            return "0";
        return juce::String (s.substr (start, end - start));
    };

    juce::StringArray toks;
    for (auto* k : { "wetDryMix", "shift", "feedback", "sync", "lowCut", "highCut" })
        toks.add (getAttr (k));
    return toks.joinIntoString (" ");
}

// Build the VST3-host-wrapped state blob that selects an Airwindows
// Consolidated algorithm. The inner XML shape is dictated by
// AWConsolidatedAudioProcessor::getStateInformation (see docs/57c
// §"How algorithm selection actually works"). JUCE's VST3 host wrapper
// then expects that blob to be base64-encoded inside
// <VST3PluginState><IComponent>…</IComponent></VST3PluginState>.
//
// The returned bytes are what `<PLUGIN state="…">` rack XML expects:
// the bytes are emitted by JUCE as base64 itself via copyXmlToBinary +
// MemoryBlock::toBase64Encoding round-tripping. To embed directly in
// the rack XML we call .toBase64Encoding() on the final wrapper bytes
// once more.
inline juce::String buildAwconsolidatedStateBlobBase64 (const juce::String& algorithmName)
{
    juce::XmlElement inner ("awconsolidated");
    inner.setAttribute ("streamingVersion", (int) 8524);
    inner.setAttribute ("currentProcessorName", algorithmName);
    for (int i = 0; i < 10; ++i)
        inner.setAttribute (juce::String ("awp_") + juce::String (i), 0.5);
    inner.setAttribute ("inlev", 0.5);
    inner.setAttribute ("outlev", 0.5);
    inner.setAttribute ("monoBehaviour", 0.0);

    juce::MemoryBlock innerBlob;
    juce::AudioProcessor::copyXmlToBinary (inner, innerBlob);

    juce::XmlElement wrapper ("VST3PluginState");
    auto* ic = wrapper.createNewChildElement ("IComponent");
    ic->addTextElement (innerBlob.toBase64Encoding());

    juce::MemoryBlock wrapped;
    juce::AudioProcessor::copyXmlToBinary (wrapper, wrapped);

    return wrapped.toBase64Encoding();
}

enum class RemapAction
{
    rewroteToTracktionInternal,
    rewroteToConsolidated,
    rewroteToCasperakiSimpleSide,      // in-tree SimpleSide reimpl (was external VST)
    rewroteToCasperakiFreqShiftEcho,   // in-tree ValhallaFreqEcho reimpl (was Wine/yabridge)
    unmapped, // caller decides to drop or leave
};

// Apply the Linux remap to a <PLUGIN> XML node IN PLACE. Returns the
// action taken so the caller can log / drop unmapped slots.
inline RemapAction remapPluginElement (juce::XmlElement& plugin)
{
    const auto legacyName = legacyBasename (plugin.getStringAttribute (ids::kFile));

    if (auto it = legacyToTracktionInternal().find (legacyName);
        it != legacyToTracktionInternal().end())
    {
        plugin.setAttribute (ids::kType, it->second);
        plugin.removeAttribute (ids::kFile);
        // Translate the legacy state attribute across TWO format gaps:
        //
        //   1. Encoding: legacy uses MemoryBlock::toBase64Encoding
        //      (prefixed "N.<base64>") but AirWindowsPlugin's
        //      restorePluginStateFromValueTree uses plain
        //      juce::Base64::convertFromBase64.
        //
        //   2. Wrapper: legacy state was emitted by ExternalPlugin via
        //      VSTPluginInstance::getStateInformation → saveToFXBFile,
        //      which wraps the actual VST2 chunk in an FXB "FBCh"
        //      envelope (160-byte header, then chunkSize int32 implicit
        //      in size, then the chunk bytes). AirWindowsPlugin instead
        //      passes the decoded bytes STRAIGHT to impl->setChunk — the
        //      Airwindows source expects the bare float[N] chunk with
        //      no envelope. Without the unwrap the first N×4 bytes of
        //      the FBCh header get reinterpreted as parameter floats →
        //      e.g. Pyewacket's Boost knob lands at garbage values and
        //      pile-drives drums into distortion.
        //
        // Unwrap: verify the "CcnK" + "FBCh" magic at offsets 0/8, then
        // hand only bytes[160:] (the actual Airwindows chunk) to setChunk
        // via plain base64.
        const auto legacyState = plugin.getStringAttribute (ids::kState);
        if (legacyState.isNotEmpty())
        {
            juce::MemoryBlock mb;
            if (! mb.fromBase64Encoding (legacyState))
            {
                plugin.removeAttribute (ids::kState);
            }
            else
            {
                const auto* bytes = static_cast<const char*> (mb.getData());
                const auto totalSize = mb.getSize();

                const bool looksLikeFXB =
                    totalSize >= kFXBHeaderSize
                    && bytes[0] == 'C' && bytes[1] == 'c' && bytes[2] == 'n' && bytes[3] == 'K'
                    && bytes[8] == 'F' && bytes[9] == 'B' && bytes[10] == 'C' && bytes[11] == 'h';

                if (looksLikeFXB)
                    plugin.setAttribute (ids::kState,
                        juce::Base64::toBase64 (bytes + kFXBHeaderSize,
                                                totalSize - kFXBHeaderSize));
                else
                    plugin.removeAttribute (ids::kState);
            }
        }
        return RemapAction::rewroteToTracktionInternal;
    }

    // Tracktion's ExternalPlugin::xmlTypeName is "vst" for ALL external
    // plugin formats (VST2 + VST3 + AU). The format is resolved internally
    // via the plugin description matched against knownPluginList. So all
    // of Consolidated, SimpleSide, and Valhalla use type="vst" — the
    // format-specific scan in CasperakiEngine::scanExternalPlugins places
    // each into knownPluginList tagged with its format.
    if (auto it = legacyToConsolidatedAlgorithm().find (legacyName);
        it != legacyToConsolidatedAlgorithm().end())
    {
        plugin.setAttribute (ids::kType, juce::String ("vst"));
        plugin.setAttribute (ids::kFile, getConsolidatedVst3Path());
        plugin.setAttribute (ids::kState, buildAwconsolidatedStateBlobBase64 (it->second));
        return RemapAction::rewroteToConsolidated;
    }

    if (legacyName == "SimpleSide" || legacyName == "SimpleSide 2")
    {
        // RETIRED external VST -> in-tree CasperakiSimpleSidePlugin. Decode the
        // legacy state (2 doubles + curve triples) into the flat param list the
        // wrapper reads from `casperakiFxParams`; drop the external file/state.
        const auto legacyState = plugin.getStringAttribute (ids::kState);
        plugin.setAttribute (ids::kType, juce::String (kCasperakiSimpleSideType));
        plugin.removeAttribute (ids::kFile);
        plugin.removeAttribute (ids::kState);
        plugin.setAttribute ("casperakiFxParams", decodeSimpleSideParams (legacyState));
        return RemapAction::rewroteToCasperakiSimpleSide;
    }

    if (legacyName == "ValhallaFreqEcho" || legacyName == "ValhallaFreqEcho_x")
    {
        // RETIRED proprietary/Wine-bridged VST -> in-tree CasperakiFreqShiftEchoPlugin.
        // Decode the six knobs from the FXB-wrapped XML state into the wrapper's
        // `casperakiFxParams`; drop the external file/state (no more yabridge/Wine).
        const auto legacyState = plugin.getStringAttribute (ids::kState);
        plugin.setAttribute (ids::kType, juce::String (kCasperakiFreqShiftEchoType));
        plugin.removeAttribute (ids::kFile);
        plugin.removeAttribute (ids::kState);
        plugin.setAttribute ("casperakiFxParams", decodeValhallaParams (legacyState));
        return RemapAction::rewroteToCasperakiFreqShiftEcho;
    }

    return RemapAction::unmapped;
}

} // namespace fx_remap
