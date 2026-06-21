// Runtime-loaded mix/FX configuration for the NATIVE engine (docs/64/65 — shared
// config JSON). This is the native mirror of the WASM
// apps/web/wasm/engine/src/audio/MixConfig.h: it reads the SAME
// casperaki_engine/config/mix-config.json at startup so the per-lane volumes,
// fxGroup routing, aux-send levels and master/transition trims live in ONE
// editable place shared by both engines.
//
// The lookup semantics mirror the WASM MixConfig.h / MixTables.h exactly:
//   - targetVolume: ordered rules, first match wins, no match -> 0
//   - fxGroup:      map lookup, unmapped -> "drums"
//   - instrumentFxSends: map lookup, unmapped -> {-25,-100,-100} (drums fallback)
//   - laneSends:    instrumentFxSends(group) + the byType (first-match) then
//                   byGroupGenre overrides (Sequencer.cpp:251-336 in JSON form)
//
// The hardcoded values in FX.h (getInstrumentTargetVolume, typeMappingTable,
// instrumentFxSettings) and Sequencer.cpp (the prepareInstrumentTracksWithPlugins
// send chain, the -10/-1 dB trims) are kept as the fallback used when the JSON
// cannot be loaded (loaded() == false), so nothing breaks when the file is absent.
//
// Phase 1: mix tables only. Rack chains (rackChains in the JSON) stay on
// PresetManager.h base64 — native rack-from-{factory,params} reconstruction is
// phase 2.
#pragma once

#include "json.hpp"  // nlohmann::json — already vendored in Source/

#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

namespace casperaki {
namespace mix {

struct Sends { float reverb, delay, chorus; };

class MixConfig {
public:
    // Lazy singleton. Loads from $CASPERAKI_MIX_CONFIG (or, when unset,
    // $HOME/apps/casperaki_engine/config/mix-config.json) on first access.
    // If the file is missing/unparseable, loaded() stays false and every call
    // site falls back to its hardcoded values.
    static const MixConfig& instance() {
        static const MixConfig c = load();
        return c;
    }

    bool loaded() const { return loaded_; }

    // --- lookups (mirror WASM MixConfig.h / MixTables.h) ---
    double targetVolume(const std::string& t, const std::string& g) const {
        for (const auto& r : tv_) {
            if (r.type != t) continue;
            if (r.genres.empty()) return r.db;          // generic row
            for (const auto& gg : r.genres) if (gg == g) return r.db;
        }
        return 0.0;
    }

    const std::string& fxGroup(const std::string& t) const {
        auto it = typeToFxGroup_.find(t);
        return it != typeToFxGroup_.end() ? it->second : kDrums_;
    }

    Sends instrumentFxSends(const std::string& group) const {
        auto it = fxSends_.find(group);
        return it != fxSends_.end() ? it->second : Sends{-25, -100, -100};
    }

    Sends laneSends(const std::string& group, const std::string& t, const std::string& g) const {
        Sends s = instrumentFxSends(group);
        for (const auto& o : byType_) {
            bool match = false;
            for (const auto& ot : o.types) if (ot == t) { match = true; break; }
            if (!match) continue;
            if (o.set) {
                if (o.hasR) s.reverb = (float)o.r;
                if (o.hasD) s.delay  = (float)o.d;
                if (o.hasC) s.chorus = (float)o.c;
            } else {
                if (o.hasR) s.reverb += (float)o.r;
                if (o.hasD) s.delay  += (float)o.d;
                if (o.hasC) s.chorus += (float)o.c;
            }
            break;  // first-match (mirrors the if/else-if chain)
        }
        for (const auto& o : byGroupGenre_)
            if (o.group == group && o.genre == g) s.reverb = (float)o.reverb;
        return s;
    }

    double masterVolumeDb() const { return masterVolumeDb_; }
    double transitionsTrimDb() const { return transitionsTrimDb_; }
    double volScaleFactor() const { return volScaleFactor_; }

private:
    struct TVRule { std::string type; std::vector<std::string> genres; double db; };
    struct SendOverride { std::vector<std::string> types; bool set = false;
                          bool hasR = false, hasD = false, hasC = false; double r = 0, d = 0, c = 0; };
    struct GroupGenreOverride { std::string group, genre; double reverb; };

    std::vector<TVRule> tv_;
    std::unordered_map<std::string, std::string> typeToFxGroup_;
    std::unordered_map<std::string, Sends> fxSends_;
    std::vector<SendOverride> byType_;
    std::vector<GroupGenreOverride> byGroupGenre_;
    double masterVolumeDb_ = -1.0, transitionsTrimDb_ = -10.0, volScaleFactor_ = 20.0;
    bool loaded_ = false;
    inline static const std::string kDrums_ = "drums";

    static std::string configPath() {
        if (const char* env = std::getenv("CASPERAKI_MIX_CONFIG"))
            if (env[0] != '\0') return env;
        std::string home = std::getenv("HOME") ? std::getenv("HOME") : "";
        return home + "/apps/casperaki_engine/config/mix-config.json";
    }

    static MixConfig load() {
        MixConfig c;
        try {
            std::ifstream f(configPath());
            if (!f) return c;  // loaded_ stays false -> hardcoded fallback
            std::stringstream ss; ss << f.rdbuf();
            c.parse(nlohmann::json::parse(ss.str()));
            c.loaded_ = true;
        } catch (...) {
            return MixConfig{};  // any parse error -> fallback
        }
        return c;
    }

    void parse(const nlohmann::json& j) {
        const auto& consts = j.at("constants");
        masterVolumeDb_ = consts.value("masterVolumeDb", -1.0);
        transitionsTrimDb_ = consts.value("transitionsTrimDb", -10.0);
        volScaleFactor_ = consts.value("volScaleFactor", 20.0);

        for (auto it = j.at("typeToFxGroup").begin(); it != j.at("typeToFxGroup").end(); ++it)
            typeToFxGroup_[it.key()] = it.value().get<std::string>();

        for (const auto& r : j.at("instrumentTargetVolume")) {
            TVRule rule;
            rule.type = r.at("type").get<std::string>();
            if (r.contains("genres"))
                for (const auto& g : r.at("genres")) rule.genres.push_back(g.get<std::string>());
            rule.db = r.at("db").get<double>();
            tv_.push_back(std::move(rule));
        }

        for (auto it = j.at("instrumentFxSends").begin(); it != j.at("instrumentFxSends").end(); ++it) {
            const auto& v = it.value();
            fxSends_[it.key()] = Sends{ v.at("reverb").get<float>(),
                                        v.at("delay").get<float>(),
                                        v.at("chorus").get<float>() };
        }

        const auto& ov = j.at("laneSendOverrides");
        for (const auto& o : ov.at("byType")) {
            SendOverride s;
            for (const auto& t : o.at("types")) s.types.push_back(t.get<std::string>());
            s.set = (o.at("op").get<std::string>() == "set");
            if (o.contains("reverb")) { s.hasR = true; s.r = o.at("reverb").get<double>(); }
            if (o.contains("delay"))  { s.hasD = true; s.d = o.at("delay").get<double>(); }
            if (o.contains("chorus")) { s.hasC = true; s.c = o.at("chorus").get<double>(); }
            byType_.push_back(std::move(s));
        }
        for (const auto& o : ov.at("byGroupGenre")) {
            GroupGenreOverride g;
            g.group = o.at("group").get<std::string>();
            g.genre = o.at("genre").get<std::string>();
            g.reverb = o.at("reverb").get<double>();  // all current rules set reverb
            byGroupGenre_.push_back(std::move(g));
        }
    }
};

} // namespace mix
} // namespace casperaki
