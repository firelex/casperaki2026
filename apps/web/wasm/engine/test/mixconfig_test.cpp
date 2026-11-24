// The shared mix config (docs/64), in two parts:
//
// 1. Reading a config: test/fixtures/mix-config-tables.json is the config as it was
//    generated from the compiled-in tables (casperaki_engine c45f53b). MixConfig must
//    reproduce MixTables.h + RackData.h from it EXACTLY, over every (type, genre) and
//    every rack, so the lookups (first-match rules, sends, racks) are known to be right.
//    (MIXCONFIG_TABLES_PATH)
// 2. The live config (casperaki_engine/config/mix-config.json, MIXCONFIG_JSON_PATH):
//    it changes on purpose (Pro-mode approvals, new routing, new racks), so it is not
//    compared with the tables; it must load and be complete: every group bus a type
//    plays through has a rack and sends, the master and the three returns have racks,
//    and every rack plugin is one the engine builds, with as many settings as it has.

#include "../src/audio/MixConfig.h"
#include "../src/audio/MixTables.h"
#include "../src/audio/MixGraph.h"

#include <cstdio>
#include <set>
#include <string>
#include <vector>

namespace {
int failures = 0;
void check(bool cond, const std::string& msg) {
    if (!cond) { std::printf("FAIL: %s\n", msg.c_str()); ++failures; }
}
} // namespace

int main() {
    using namespace casperaki;
    mix::MixConfig cfg;
    try {
        cfg = mix::MixConfig::fromFile(MIXCONFIG_TABLES_PATH);
    } catch (const std::exception& e) {
        std::printf("FAIL: cannot load %s: %s\n", MIXCONFIG_TABLES_PATH, e.what());
        return 1;
    }

    // The full type set + genre set the engine can ever query.
    std::vector<std::string> genres = { "", "ballad", "brightPop", "edm", "latin",
                                        "organicVibes", "rock", "schlager", "urban" };
    // Read the type list straight from the JSON (typeToFxGroup keys + every tv rule type).
    nlohmann::json j = nlohmann::json::parse([] {
        std::ifstream f(MIXCONFIG_TABLES_PATH); std::stringstream ss; ss << f.rdbuf(); return ss.str();
    }());
    std::vector<std::string> types;
    for (auto it = j["typeToFxGroup"].begin(); it != j["typeToFxGroup"].end(); ++it)
        types.push_back(it.key());
    for (const auto& r : j["instrumentTargetVolume"]) {
        const std::string t = r["type"].get<std::string>();
        bool seen = false; for (const auto& x : types) if (x == t) { seen = true; break; }
        if (!seen) types.push_back(t);
    }
    // A couple of unmapped types to exercise the fallbacks.
    types.push_back("totallyUnknownType");
    types.push_back("");

    int tvChecks = 0, fgChecks = 0, lsChecks = 0;
    std::vector<std::string> unmapped;
    for (const auto& t : types) {
        // fxGroup: a mapped type matches the compiled-in table; a type the map does
        // not list throws (the compiled-in table still falls back to "drums").
        if (j["typeToFxGroup"].contains(t)) {
            check(cfg.fxGroup(t) == mix::getFxGroup(t),
                  "fxGroup mismatch for " + t + ": cfg=" + cfg.fxGroup(t) + " hc=" + mix::getFxGroup(t));
        } else {
            bool threw = false;
            try { (void)cfg.fxGroup(t); } catch (const std::runtime_error&) { threw = true; }
            check(threw, "fxGroup of the unmapped type '" + t + "' did not throw");
            unmapped.push_back(t);
        }
        ++fgChecks;
        for (const auto& g : genres) {
            // targetVolume
            double a = cfg.targetVolume(t, g), b = mix::getInstrumentTargetVolume(t, g);
            check(a == b, "targetVolume mismatch " + t + "/" + g + ": " +
                          std::to_string(a) + " vs " + std::to_string(b));
            ++tvChecks;
            // laneSends (group derived from type)
            const std::string grp = mix::getFxGroup(t);
            mix::FxSends ca = cfg.laneSends(grp, t, g), cb = mix::laneSendsDb(grp, t, g);
            check(ca.reverb == cb.reverb && ca.delay == cb.delay && ca.chorus == cb.chorus,
                  "laneSends mismatch " + t + "/" + g);
            ++lsChecks;
        }
    }

    // instrumentFxSends over every fxGroup (incl an unknown -> drums fallback).
    for (const std::string grp : { "fx","kicks","drums","percussion","bass","keys","synths",
                                   "leadSynths","acousticGuitars","electricGuitars","orchestral",
                                   "snares","toms","vocals","unknownGroup" }) {
        mix::FxSends a = cfg.instrumentFxSends(grp), b = mix::instrumentFxSends(grp);
        check(a.reverb == b.reverb && a.delay == b.delay && a.chorus == b.chorus,
              "instrumentFxSends mismatch " + grp);
    }

    // constants
    check(cfg.masterVolumeDb() == mix::kMasterVolumeDb, "masterVolumeDb mismatch");

    // rackChains: bus order, plugin factories, params (float-exact).
    const auto& hc = mix::rackChains();
    const auto& cc = cfg.rackChains();
    check(hc.size() == cc.size(), "rackChains bus count: hc=" + std::to_string(hc.size()) +
          " cfg=" + std::to_string(cc.size()));
    for (size_t i = 0; i < hc.size() && i < cc.size(); ++i) {
        check(hc[i].bus == cc[i].bus, "rack bus name #" + std::to_string(i));
        check(hc[i].plugins.size() == cc[i].plugins.size(), "rack plugin count for " + hc[i].bus);
        for (size_t p = 0; p < hc[i].plugins.size() && p < cc[i].plugins.size(); ++p) {
            check(hc[i].plugins[p].factory == cc[i].plugins[p].factory,
                  "rack factory " + hc[i].bus + "#" + std::to_string(p));
            const auto& ph = hc[i].plugins[p].params;
            const auto& pc = cc[i].plugins[p].params;
            check(ph.size() == pc.size(), "rack param count " + hc[i].bus + "/" +
                  hc[i].plugins[p].factory);
            for (size_t k = 0; k < ph.size() && k < pc.size(); ++k)
                check(ph[k] == pc[k], "rack param " + hc[i].bus + "/" + hc[i].plugins[p].factory +
                      "[" + std::to_string(k) + "]: " + std::to_string(ph[k]) + " vs " + std::to_string(pc[k]));
        }
    }

    // Pro routing (laneOverrides.<lane>.fxGroup): a group bus is accepted and read
    // back; the master, an aux return or a bus the rack chains lack is an error.
    {
        nlohmann::json pro = j;
        pro["laneOverrides"] = { { "Keys", { { "fxGroup", "synths" } } }, { "Bass", { { "volumeDb", -3.0 } } } };
        const auto pc = mix::MixConfig::fromJson(pro);
        const auto* ko = pc.laneOverride("Keys");
        check(ko && ko->fxGroup == "synths", "laneOverrides.Keys.fxGroup not read back");
        const auto* bo = pc.laneOverride("Bass");
        check(bo && bo->fxGroup.empty() && bo->hasVolume, "laneOverrides.Bass gained a route it was not given");
        for (const std::string bad : { "master", "fxPlateReverb", "fxStereoDelay", "fxChorus", "noSuchBus" }) {
            nlohmann::json b = j;
            b["laneOverrides"] = { { "Keys", { { "fxGroup", bad } } } };
            bool threw = false;
            try { (void)mix::MixConfig::fromJson(b); } catch (const std::runtime_error&) { threw = true; }
            check(threw, "laneOverrides fxGroup '" + bad + "' was accepted");
        }
    }

    // ---- 2. The live config: loads and is complete ----
    int liveRacks = 0;
    {
        mix::MixConfig live;
        bool loaded = true;
        try { live = mix::MixConfig::fromFile(MIXCONFIG_JSON_PATH); }
        catch (const std::exception& e) { std::printf("FAIL: cannot load %s: %s\n", MIXCONFIG_JSON_PATH, e.what()); ++failures; loaded = false; }
        if (loaded) {
            nlohmann::json lj = nlohmann::json::parse([] {
                std::ifstream f(MIXCONFIG_JSON_PATH); std::stringstream ss; ss << f.rdbuf(); return ss.str();
            }());
            std::set<std::string> rackBuses;
            for (const auto& r : live.rackChains()) rackBuses.insert(r.bus);
            for (const std::string bus : { "master", "fxPlateReverb", "fxStereoDelay", "fxChorus" })
                check(rackBuses.count(bus) == 1, "live config: no rack for the " + bus + " bus");
            std::set<std::string> groups;
            for (auto it = lj["typeToFxGroup"].begin(); it != lj["typeToFxGroup"].end(); ++it)
                groups.insert(it.value().get<std::string>());
            for (const auto& g : groups) {
                check(rackBuses.count(g) == 1, "live config: types play through the " + g + " bus, which has no rack");
                check(lj["instrumentFxSends"].contains(g), "live config: the " + g + " bus has no sends (instrumentFxSends)");
            }
            for (const auto& r : live.rackChains()) {
                ++liveRacks;
                for (const auto& pd : r.plugins) {
                    try {
                        auto p = makeAwByFactory(pd.factory, 48000.0, pd.params);
                        check((int)pd.params.size() <= p->numParams(),
                              "live config: " + r.bus + "/" + pd.factory + " has " + std::to_string(pd.params.size()) +
                              " settings; the plugin has " + std::to_string(p->numParams()));
                    } catch (const std::exception& e) {
                        check(false, "live config: " + r.bus + "/" + pd.factory + ": " + e.what());
                    }
                }
            }
        }
    }

    std::printf("mixconfig_test: unmapped types (throw): ");
    for (const auto& t : unmapped) std::printf("'%s' ", t.c_str());
    std::printf("\n");
    std::printf("mixconfig_test: tables fixture: %d targetVolume, %d fxGroup, %d laneSends checks; %zu racks; live config: %d racks checked\n",
                tvChecks, fgChecks, lsChecks, cc.size(), liveRacks);
    if (failures) { std::printf("mixconfig_test: %d FAILURES\n", failures); return 1; }
    std::printf("mixconfig_test: OK\n");
    return 0;
}
