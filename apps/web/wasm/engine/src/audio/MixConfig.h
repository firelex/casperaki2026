// Runtime-loaded mix/FX configuration (docs/64 — shared config JSON). Replaces
// the compiled-in MixTables.h data tables + RackData.h rack chains with values
// read at startup from casperaki_engine/config/mix-config.json, so the per-lane
// volumes, fxGroup routing, aux-send levels, master/transition trims and rack
// plugin params live in ONE editable place shared by both engines (and, later,
// drive configurable virtual FX lanes in the UI).
//
// The lookup semantics mirror MixTables.h exactly:
//   - targetVolume: ordered rules, first match wins, no match -> 0
//   - fxGroup:      map lookup, unmapped -> "drums"
//   - instrumentFxSends: map lookup, unmapped -> {-25,-100,-100} (drums fallback)
//   - laneSends:    instrumentFxSends(group) + the byType then byGroupGenre overrides
// A mixconfig_test asserts this matches the hardcoded mix:: functions over every
// (type, genre) before the engine switches to it (the parity gate).
//
// Pure math (dbToGain / dbToFaderPos / faderPosToGain) and the FxSends struct
// stay in MixTables.h — those are formulas, not data.
#pragma once

#include "../../vendor/json.hpp"
#include "MixTables.h"
#include "RackData.h"   // RackPluginDef / RackDef structs (the compiled-in table is
                        // unused once the engine reads rackChains from JSON; kept
                        // for the parity test that compares the two).

#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace casperaki {
namespace mix {

class MixConfig {
public:
    static MixConfig fromJson(const nlohmann::json& j) {
        MixConfig c;
        const auto& consts = j.at("constants");
        c.masterVolumeDb_ = consts.value("masterVolumeDb", -1.0);
        c.transitionsTrimDb_ = consts.value("transitionsTrimDb", -10.0);
        c.volScaleFactor_ = consts.value("volScaleFactor", 20.0);

        for (auto it = j.at("typeToFxGroup").begin(); it != j.at("typeToFxGroup").end(); ++it)
            c.typeToFxGroup_[it.key()] = it.value().get<std::string>();

        for (const auto& r : j.at("instrumentTargetVolume")) {
            TVRule rule;
            rule.type = r.at("type").get<std::string>();
            if (r.contains("genres"))
                for (const auto& g : r.at("genres")) rule.genres.push_back(g.get<std::string>());
            rule.db = r.at("db").get<double>();
            c.tv_.push_back(std::move(rule));
        }

        for (auto it = j.at("instrumentFxSends").begin(); it != j.at("instrumentFxSends").end(); ++it) {
            const auto& v = it.value();
            c.fxSends_[it.key()] = FxSends{ v.at("reverb").get<float>(),
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
            c.byType_.push_back(std::move(s));
        }
        for (const auto& o : ov.at("byGroupGenre")) {
            GroupGenreOverride g;
            g.group = o.at("group").get<std::string>();
            g.genre = o.at("genre").get<std::string>();
            g.reverb = o.at("reverb").get<double>();  // all current rules set reverb
            c.byGroupGenre_.push_back(std::move(g));
        }

        for (const auto& rc : j.at("rackChains")) {
            RackDef rd;
            rd.bus = rc.at("bus").get<std::string>();
            for (const auto& p : rc.at("plugins")) {
                RackPluginDef pd;
                pd.factory = p.at("factory").get<std::string>();
                for (const auto& v : p.at("params")) pd.params.push_back(v.get<float>());
                rd.plugins.push_back(std::move(pd));
            }
            c.rackChains_.push_back(std::move(rd));
        }
        return c;
    }

    static MixConfig fromFile(const std::string& path) {
        std::ifstream f(path);
        if (!f) throw std::runtime_error("MixConfig: cannot open " + path);
        std::stringstream ss; ss << f.rdbuf();
        return fromJson(nlohmann::json::parse(ss.str()));
    }

    // --- lookups (mirror MixTables.h) ---
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

    FxSends instrumentFxSends(const std::string& group) const {
        auto it = fxSends_.find(group);
        return it != fxSends_.end() ? it->second : FxSends{-25, -100, -100};
    }

    FxSends laneSends(const std::string& group, const std::string& t, const std::string& g) const {
        FxSends s = instrumentFxSends(group);
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
    const std::vector<RackDef>& rackChains() const { return rackChains_; }

private:
    struct TVRule { std::string type; std::vector<std::string> genres; double db; };
    struct SendOverride { std::vector<std::string> types; bool set = false;
                          bool hasR = false, hasD = false, hasC = false; double r = 0, d = 0, c = 0; };
    struct GroupGenreOverride { std::string group, genre; double reverb; };

    std::vector<TVRule> tv_;
    std::unordered_map<std::string, std::string> typeToFxGroup_;
    std::unordered_map<std::string, FxSends> fxSends_;
    std::vector<SendOverride> byType_;
    std::vector<GroupGenreOverride> byGroupGenre_;
    std::vector<RackDef> rackChains_;
    double masterVolumeDb_ = -1.0, transitionsTrimDb_ = -10.0, volScaleFactor_ = 20.0;
    inline static const std::string kDrums_ = "drums";
};

} // namespace mix
} // namespace casperaki
