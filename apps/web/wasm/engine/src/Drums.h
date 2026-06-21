// Drum step-lane resolution — re-implements casperaki_engine's Drums
// (instruments/Drums.h) drum-grid expansion. Port order = PORTING-MAP.md step 2.
//
// A drum instrument resolves to four step tracks ("<name>-kicks/-snares/-toms/
// -rest"). Each sub-instrument's pattern string ("x0--0x..", 32 steps/bar after
// retainCharacters("0x-")) is tiled across the segment's bars and routed to one
// of the four step clips by its instrumentGroup (Drums.h:225-240). Velocity is
// the channel default (127) — no RNG — so step hits assert exact.
//
// Two faithfulness notes carried from the original:
//   - Pattern application is setNote semantics: 'x' sets a hit, '0' CLEARS one.
//     Fills overlay the base pattern and can clear base hits on the same channel
//     (the fixtures' fills touch bassDrum1/snareDrum1), so hits are accumulated
//     into a (channel,step) map that 'x' writes and '0' erases — last write wins
//     across base-then-fills, exactly like te::StepClip::Pattern::setNote.
//   - The per-segment override pattern is IGNORED unless override.reset==true;
//     otherwise the BASE pattern is applied, optionally group-filtered by
//     override.type (Drums.h createSegmentClip:329-342). The 8-genre fixtures
//     all use type "brainRoundtrip" (-> OverrideType::all, no filter) with
//     reset:false, so the base pattern drives every segment.
#pragma once

#include "ResolvedEvents.h"
#include "Tonal.h"            // asStr
#include "../vendor/json.hpp"

#include <cctype>
#include <cmath>
#include <string>

namespace casperaki {

using nlohmann::json;

// Drums.h:225-240 — sub-instrument instrumentGroup -> output step track.
enum DrumGroup { dgKicks = 0, dgSnares = 1, dgToms = 2, dgRest = 3 };
inline DrumGroup drumGroupFor(const std::string& instrumentGroup) {
    if (instrumentGroup == "kickDrums")          return dgKicks;
    if (instrumentGroup == "snareDrumsClapSnap") return dgSnares;
    if (instrumentGroup == "toms")               return dgToms;
    return dgRest;
}

// Drums.h:15-37 — override type, selects which sub-instruments a base pattern
// applies to. Unknown strings (e.g. "brainRoundtrip") map to `all`.
enum DrumOverrideType {
    doAll, doBassDrumOnly, doNoBassDrum, doBassDrumAndSnareDrumOnly, doHiHatOnly,
    doBassDrumAndHiHatOnly, doBassDrumSnareDrumAndHiHatOnly, doPercussionOnly, doNoPercussion
};
inline DrumOverrideType drumOverrideTypeFromString(const std::string& s) {
    if (s == "bassDrumOnly")                  return doBassDrumOnly;
    if (s == "noBassDrum")                    return doNoBassDrum;
    if (s == "bassDrumAndSnareDrumOnly")      return doBassDrumAndSnareDrumOnly;
    if (s == "hiHatOnly")                     return doHiHatOnly;
    if (s == "percussionOnly")                return doPercussionOnly;
    if (s == "noPercussion")                  return doNoPercussion;
    if (s == "bassDrumAndHiHatOnly")          return doBassDrumAndHiHatOnly;
    if (s == "bassDrumSnareDrumAndHiHatOnly") return doBassDrumSnareDrumAndHiHatOnly;
    return doAll;
}

// Drums.h:165-219 — the override-type group filter, by sub-instrument name.
inline bool drumOverridePasses(DrumOverrideType t, const std::string& name) {
    auto starts = [&](const char* p) { return name.rfind(p, 0) == 0; };
    auto isBass  = [&] { return starts("bassDrum"); };
    auto isHiHat = [&] { return starts("hiHat"); };
    auto isSnare = [&] { return starts("snareDrum"); };
    auto isPerc  = [&] {
        return !(starts("hiHat") || starts("crash") || name == "ride" ||
                 name == "clap" || name == "snap" || name == "shaker");
    };
    switch (t) {
        case doBassDrumOnly:                  return isBass();
        case doBassDrumAndHiHatOnly:          return isBass() || isHiHat();
        case doNoBassDrum:                    return !isBass();
        case doBassDrumAndSnareDrumOnly:      return isBass() || isSnare();
        case doBassDrumSnareDrumAndHiHatOnly: return isBass() || isHiHat() || isSnare();
        case doHiHatOnly:                     return isHiHat();
        case doPercussionOnly:                return isPerc();
        case doNoPercussion:                  return !isPerc();
        default:                              return true;
    }
}

// Drums.h:40-57 — drum fill placement type.
enum DrumFillType { dfNone = -1, dfFourthBar, dfTwelfthBar, dfMiddle, dfEndOfSegment };
inline DrumFillType drumFillTypeFromString(const std::string& s) {
    if (s == "patternFourthBar")       return dfFourthBar;
    if (s == "patternTwelfthBar")      return dfTwelfthBar;
    if (s == "patternMiddleOfSegment") return dfMiddle;
    if (s == "patternEndOfSegment")    return dfEndOfSegment;
    return dfNone;
}

// Drums.h:244 / 370 — lowercase then keep only the grid characters.
inline std::string retainStepChars(const std::string& s) {
    std::string out;
    for (char c : s) {
        char l = (char)std::tolower((unsigned char)c);
        if (l == '0' || l == 'x' || l == '-') out.push_back(l);
    }
    return out;
}

// Drums.h:363-372 — bars in a pattern = ceil(firstChannelString.len / 32).
// `patternObj` is the {pattern:{<sub>:<grid>}} wrapper.
inline int drumPatternBarsCount(const json& patternObj) {
    if (!patternObj.contains("pattern") || !patternObj.at("pattern").is_object()) return 0;
    const json& pp = patternObj.at("pattern");
    if (pp.empty()) return 0;
    const std::string first = retainStepChars(asStr(pp.begin().value()));
    return (int)std::ceil(first.size() / 32.0);
}

} // namespace casperaki
