// docs/65 — rewrite a rendered Tracktion edit so the Casperaki-custom built-in
// plugins are replaced by the equivalent installable VST3s, so a producer can
// open the edit in stock Waveform. Strategy (clean slice — FreqShiftEcho + the
// AirWindows "extras"; SimpleSide deferred):
//   * for each matching built-in plugin in the live edit, instantiate the VST3
//     (engine ExternalPlugin), transfer the params, flush so its ValueTree holds
//     the correct VST3 state, then graft that <PLUGIN> node into a COPY of the
//     edit tree IN PLACE — keeping the original plugin `id` so the rack's
//     CONNECTION nodes (which reference plugin ids) stay valid.
//   * write the rewritten tree to edit-vst3.trkedit.
// The caller then reloads + renders it to verify every plugin resolves.
//
// This header assumes the Tracktion engine headers (te::) are already included
// by the TU (harness.cpp).
#pragma once

#include <map>
#include <string>
#include <vector>

namespace casperaki_export {

namespace te = tracktion::engine;

// Built-in plugin type -> VST3 product name. SimpleSide is intentionally absent
// (its variable-length control-point params need a bespoke VST3 layout first).
inline const std::map<juce::String, juce::String>& typeToProduct()
{
    static const std::map<juce::String, juce::String> m = {
        { "casperaki_freqshiftecho",     "Casperaki FreqShiftEcho" },
        { "casperaki_simpleside",        "Casperaki SimpleSide" },
        { "airwindows_console8_sub_in",  "Casperaki Console8SubIn" },
        { "airwindows_console8_sub_out", "Casperaki Console8SubOut" },
        { "airwindows_console8_buss_in", "Casperaki Console8BussIn" },
        { "airwindows_console8_buss_out","Casperaki Console8BussOut" },
        { "airwindows_kplate_d",         "Casperaki kPlateD" },
        { "airwindows_kplate_a",         "Casperaki kPlateA" },
        { "airwindows_texturizems",      "Casperaki TexturizeMS" },
        { "airwindows_stereochorus",     "Casperaki StereoChorus" },
        { "airwindows_huge",             "Casperaki Huge" },
        // airwindows_air2 intentionally omitted — not used by any rack chain.
    };
    return m;
}

// The built-in plugin stores its params either as a space-separated
// `casperakiFxParams` string (the bespoke FX) or a base64 little-endian float
// `state` chunk (the AirWindows plugins). Both decode to the raw param vector.
inline std::vector<float> readInternalParams (const juce::ValueTree& s)
{
    std::vector<float> v;
    if (s.hasProperty ("casperakiFxParams"))
    {
        auto toks = juce::StringArray::fromTokens (s.getProperty ("casperakiFxParams").toString(), " ", "");
        for (auto& t : toks) if (t.isNotEmpty()) v.push_back (t.getFloatValue());
    }
    else if (s.hasProperty (te::IDs::state))
    {
        juce::MemoryBlock mb;
        mb.fromBase64Encoding (s.getProperty (te::IDs::state).toString());
        const auto n = mb.getSize() / sizeof (float);
        auto* f = static_cast<const float*> (mb.getData());
        for (size_t i = 0; i < n; ++i) v.push_back (f[i]);
    }
    return v;
}

inline std::map<juce::String, juce::PluginDescription> scanVst3 (te::Engine& engine, const juce::File& dir)
{
    std::map<juce::String, juce::PluginDescription> byName;
    auto& pfm = engine.getPluginManager().pluginFormatManager;
    if (pfm.getNumFormats() == 0) pfm.addDefaultFormats();

    for (juce::RangedDirectoryIterator it (dir, true, "*.vst3", juce::File::findDirectories); it != juce::RangedDirectoryIterator(); ++it)
    {
        for (auto* fmt : pfm.getFormats())
        {
            if (juce::String (fmt->getName()) != "VST3") continue;
            juce::OwnedArray<juce::PluginDescription> found;
            fmt->findAllTypesForFile (found, it->getFile().getFullPathName());
            for (auto* d : found) byName[d->name] = *d;
        }
    }
    return byName;
}

inline juce::ValueTree findPluginById (juce::ValueTree t, const juce::var& id)
{
    if (t.hasType (te::IDs::PLUGIN) && t.getProperty (te::IDs::id) == id) return t;
    for (int i = 0; i < t.getNumChildren(); ++i)
        if (auto r = findPluginById (t.getChild (i), id); r.isValid()) return r;
    return {};
}

// Returns count swapped; appends a human-readable log to `report`.
inline int rewriteEditToVst3 (te::Edit& edit, const juce::File& vst3Dir,
                              const juce::File& outEdit, std::string& report)
{
    auto byName = scanVst3 (edit.engine, vst3Dir);
    report += "  scanned VST3s: " + std::to_string (byName.size()) + "\n";

    auto& fm = edit.engine.getPluginManager().pluginFormatManager;
    if (fm.getNumFormats() == 0) fm.addDefaultFormats();

    auto tree = edit.state.createCopy();
    int swapped = 0, skipped = 0;

    for (auto p : te::getAllPlugins (edit, true))
    {
        if (p == nullptr) continue;
        auto it = typeToProduct().find (p->getPluginType());
        if (it == typeToProduct().end()) continue;          // stock / simpleside / non-custom

        auto di = byName.find (it->second);
        if (di == byName.end()) { report += "  MISSING VST3: " + it->second.toStdString() + "\n"; ++skipped; continue; }

        const auto vals  = readInternalParams (p->state);
        const auto oldId = p->state.getProperty (te::IDs::id);

        // Load the VST3 SYNCHRONOUSLY (a Tracktion ExternalPlugin created floating
        // never instantiates, so its state can't be captured). Set the params,
        // grab the VST3 state chunk, and build the <PLUGIN type="vst"> node by
        // hand — the same fields ExternalPlugin::create + flush would write.
        juce::String err;
        auto inst = fm.createPluginInstance (di->second, 44100.0, 512, err);
        if (inst == nullptr) { report += "  load failed (" + it->second.toStdString() + "): " + err.toStdString() + "\n"; ++skipped; continue; }

        const auto& ps = inst->getParameters();
        // Set each param via getValueForText so the param's own range maps the raw
        // stored value to normalised — works for [0,1] AirWindows params AND for
        // SimpleSide's wide-range params (rate, rawExp) uniformly.
        for (int i = 0; i < (int) vals.size() && i < ps.size(); ++i)
            ps[i]->setValue (ps[i]->getValueForText (juce::String (vals[(size_t) i], 6)));

        // SimpleSide: the active control-point count is a trailing param (last),
        // not part of casperakiFxParams; derive it from the param list length.
        if (it->first == "casperaki_simpleside" && ps.size() > 0)
        {
            const int np = ((int) vals.size() - 2) / 3;
            auto* npParam = ps[ps.size() - 1];
            npParam->setValue (npParam->getValueForText (juce::String (np)));
        }

        juce::MemoryBlock chunk;
        inst->getStateInformation (chunk);

        juce::ValueTree node (te::IDs::PLUGIN);
        node.setProperty (te::IDs::type,         te::ExternalPlugin::xmlTypeName, nullptr);
        node.setProperty (te::IDs::uniqueId,     juce::String::toHexString (di->second.uniqueId), nullptr);
        node.setProperty (te::IDs::uid,          juce::String::toHexString (di->second.deprecatedUid), nullptr);
        node.setProperty (te::IDs::filename,     di->second.fileOrIdentifier, nullptr);
        node.setProperty (te::IDs::name,         di->second.name, nullptr);
        node.setProperty (te::IDs::manufacturer, di->second.manufacturerName, nullptr);
        node.setProperty (te::IDs::id,           oldId, nullptr);          // preserve id -> connections stay valid
        node.setProperty (te::IDs::enabled,      true, nullptr);
        if (chunk.getSize() > 0)
            node.setProperty (te::IDs::state, chunk.toBase64Encoding(), nullptr);

        auto target = findPluginById (tree, oldId);
        if (! target.isValid()) { report += "  node not found id=" + oldId.toString().toStdString() + "\n"; ++skipped; continue; }
        auto parent = target.getParent();
        const int idx = parent.indexOf (target);
        parent.removeChild (idx, nullptr);
        parent.addChild (node, idx, nullptr);
        ++swapped;
    }

    if (auto xml = tree.createXml())
        xml->writeTo (outEdit);

    report += "  swapped=" + std::to_string (swapped) + " skipped=" + std::to_string (skipped) + "\n";
    return swapped;
}

// Pump the message loop until no external plugin is still loading async (or
// timeout) — VST3 instances in a freshly-loaded edit instantiate asynchronously.
inline void pumpPluginLoads (te::Edit& edit, int maxMs)
{
    // A freshly-loaded edit doesn't instantiate plugins until played/rendered —
    // explicitly kick off each external plugin's (async) instantiation first.
    for (auto p : te::getAllPlugins (edit, true))
        if (auto* xp = dynamic_cast<te::ExternalPlugin*> (p))
            xp->initialiseFully();

    for (int waited = 0; waited < maxMs; waited += 50)
    {
        bool anyAsync = false;
        for (auto p : te::getAllPlugins (edit, true))
            if (auto* xp = dynamic_cast<te::ExternalPlugin*> (p))
                if (xp->isInitialisingAsync() || xp->getAudioPluginInstance() == nullptr)
                    { anyAsync = true; break; }
        if (! anyAsync) return;
        juce::MessageManager::getInstance()->runDispatchLoopUntil (50);
    }
}

// Reload a rewritten edit and report any plugin that failed to resolve.
inline int countUnresolvedPlugins (te::Edit& edit, std::string& report)
{
    int bad = 0;
    for (auto p : te::getAllPlugins (edit, true))
    {
        if (auto* xp = dynamic_cast<te::ExternalPlugin*> (p))
        {
            auto err = xp->getLoadError();
            if (err.isNotEmpty())
            {
                report += "  UNRESOLVED: " + xp->getName().toStdString() + " - " + err.toStdString() + "\n";
                ++bad;
            }
        }
    }
    return bad;
}

} // namespace casperaki_export
