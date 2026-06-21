// Serialize the ResolvedEvents IR to `casperaki/resolved-events/v1` — byte-shape
// compatible with the native harness dump (harness.cpp dumpResolvedEvents) so
// the two can be diffed by scripts/validate-resolution.mjs.
#pragma once

#include "ResolvedEvents.h"
#include "../vendor/json.hpp"

namespace casperaki {

using nlohmann::json;

inline json toResolvedEventsV1(const ResolvedEvents& ev) {
    int totalNotes = 0, totalStepHits = 0, totalWaveClips = 0;

    json tracks = json::array();
    for (const auto& t : ev.tracks) {
        json clips = json::array();
        for (const auto& c : t.clips) {
            json co = { {"name", c.name}, {"type", c.type},
                        {"startSec", c.startSec}, {"endSec", c.endSec} };
            if (c.type == "midi") {
                json notes = json::array();
                for (const auto& n : c.notes)
                    notes.push_back({ {"n", n.n}, {"name", n.name},
                                      {"startBeat", n.startBeat},
                                      {"lenBeats", n.lenBeats}, {"vel", n.vel} });
                totalNotes += (int)c.notes.size();
                co["noteCount"] = (int)c.notes.size();
                co["notes"] = notes;
            } else if (c.type == "step") {
                json channels = json::array();
                for (const auto& ch : c.channels)
                    channels.push_back({ {"note", ch.n}, {"name", ch.name} });
                co["channels"] = channels;
                json patterns = json::array();
                for (const auto& p : c.patterns) {
                    json hits = json::array();
                    for (const auto& h : p.hits)
                        hits.push_back({ {"ch", h.ch}, {"step", h.step}, {"vel", h.vel} });
                    totalStepHits += (int)p.hits.size();
                    patterns.push_back({ {"name", p.name},
                                         {"numSteps", p.numSteps}, {"hits", hits} });
                }
                co["patterns"] = patterns;
            } else if (c.type == "wave") {
                co["source"] = c.source;
                ++totalWaveClips;
            }
            clips.push_back(co);
        }
        tracks.push_back({ {"name", t.name}, {"clips", clips} });
    }

    return json{
        {"schema", "casperaki/resolved-events/v1"},
        {"genre", ev.genre},
        {"lengthSec", ev.lengthSec},
        {"totals", { {"tracks", (int)ev.tracks.size()}, {"notes", totalNotes},
                     {"stepHits", totalStepHits}, {"waveClips", totalWaveClips} }},
        {"tracks", tracks},
    };
}

} // namespace casperaki
