// Guitar lane resolution — re-implements casperaki_engine's Guitar.h +
// the strum/fret-noise builders in SequencerUtils.h. The Guitar instrument
// (electricGuitars/acousticGuitars, id 39111 in the fixtures) resolves into
// FOUR tracks (Guitar.h:38-41, getAudioTracks order short/long/fret/strums):
//   - "(short notes)" / "(long notes)": tonal notes (note/chord/noteRelative/
//     strum), split dur<=0.5 vs dur>0.5, VelocityMode::randomised.
//   - "(fret noises)": fretNoise notes (getFretNoises), velocity from data.
//   - "(strums)": virtualGuitarist strums — a midi clip (the strum notes,
//     velocity 65) + a step clip (one channel per distinct strum sample used in
//     the segment, no hits — the step/fx branch is dead, see below).
//
// PORTING-MAP step 5. Parity policy (docs/61 §2): pitch/timing/structure exact;
// velocity exact on the strums (no RNG draw — added straight via te addNote) and
// fret noises (data-driven), but STATISTICAL on the short/long tonal tracks,
// which draw VelocityMode::randomised from a clock-seeded global juce::Random
// (SequencerUtils.h:73) — non-reproducible until the native golden is
// regenerated from a determinised build (Phase 2). We still draw our own RNG in
// the faithful order so the engine is deterministic + Phase-2-ready; the
// validator just doesn't require velocity equality on those two tracks.
#pragma once

#include "Tonal.h"
#include "music/ChordData.h"
#include "../vendor/json.hpp"

#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace casperaki {

using nlohmann::json;

// music/Chord.h:484-559 GuitarChord. Looks the chord up in ChordData.json by
// (root, suffix) and returns positions[0].midi — the legacy app always picks the
// first position (getLowestPosition:539). The midi array is the open-string
// voicing the `strum` note type indexes into.
struct GuitarChord {
    // Parse the embedded database once.
    static const json& db() {
        static const json parsed = json::parse(music::kChordDataJson);
        return parsed;
    }

    std::vector<int> midi; // positions[0].midi for the resolved variant ({} if none)

    explicit GuitarChord(music::Chord chord) {
        const std::string root = chord.getRootNote().toString(false);
        std::string suffix = music::Chord::chordTypeToString(chord.getType());
        if (suffix == "sus") suffix = "sus4"; // Chord.h:498-501

        const json& d = db();
        auto rit = d.find(root);
        if (rit == d.end() || !rit->is_array()) return;
        for (const auto& variant : *rit) {
            if (variant.value("suffix", std::string()) != suffix) continue;
            const auto& positions = variant.at("positions");
            if (!positions.is_array() || positions.empty()) break;
            const auto& m = positions[0].at("midi");
            for (const auto& v : m) midi.push_back((int)v.get<double>());
            break;
        }
    }
};

// SequencerUtils.h:31-71 TimeStrums.
struct TimeStrums {
    enum Type { shortStrumUp, shortStrumDown, longStrumUp, longStrumDown, fx };

    music::Chord chord{"C"};
    int chordPosition = 1;
    std::string fxName;
    double start = 0;
    double duration = -1;
    Type type = shortStrumUp;
    int velocity = 65;

    static const char* typeStrings(int i) {
        static const char* s[] = {"chordShortStrumUp", "chordShortStrumDown",
                                  "chordLongStrumUp", "chordLongStrumDown", "fx"};
        return s[i];
    }
    std::string typeAsString() const { return typeStrings((int)type); }

    void setTypeFromString(const std::string& s) {
        for (int i = 0; i < 4; ++i)
            if (s == typeStrings(i)) { type = (Type)i; return; }
        if (s.rfind("fx", 0) == 0) { type = fx; return; }
        throw std::invalid_argument("Invalid strum type string: " + s);
    }
};

// Guitar.h:253-317 — the virtual-guitarist sample set only ships a handful of
// chord flavours, so ensureSampleMidiNote collapses every ChordType onto one of
// {"", "7", "sus2", "sus4", "6", "9", "m", "m7"}. This suffix + root + position
// + strum type forms the sample key (and thus the per-instrument sound index).
inline std::string virtualGuitaristSuffix(music::Chord::ChordType t) {
    using C = music::Chord;
    switch (t) {
        case C::major: case C::Mdim: case C::M5: case C::Malt: case C::Maug:
            return "";
        case C::Mdim7: case C::M7: case C::M7b5: case C::Maug7: case C::M7b9:
        case C::M7s9: case C::Mmaj7: case C::Mmaj7b5: case C::Mmaj7s5:
            return "7";
        case C::Msus2: return "sus2";
        case C::Msus4: case C::M7sus4: return "sus4";
        case C::M6: case C::M69: case C::M13: case C::Mmaj13: return "6";
        case C::M9: case C::M9b5: case C::Maug9: case C::M9s11: case C::Mmaj9:
        case C::Madd9: case C::M11: case C::Mmaj11:
            return "9";
        case C::minor: case C::m6: case C::m9: case C::m69: case C::mmaj9:
        case C::m11: case C::mmaj11: case C::madd9:
            return "m";
        case C::m7: case C::m7b5: case C::mmaj7: case C::mmaj7b5:
            return "m7";
        case C::invalidChord:
        default:
            return "";
    }
}

// Guitar.h:246-322 sampleKey computation (the part that feeds the sound index).
inline std::string strumSampleKey(const TimeStrums& s) {
    if (s.type == TimeStrums::fx) return s.fxName;
    std::string chordStr = music::Note(s.chord.rootNote).toString(false)
                         + virtualGuitaristSuffix(s.chord.type);
    return chordStr + "_" + std::to_string(s.chordPosition) + "_" + s.typeAsString();
}

// SequencerUtils.h:220-268 getStrumNotes — voice a `strum` note over the chord's
// guitar shape, one tonal TimeNote per entry in `strings`. NB the all-(-1)
// "mimic upward strum" branch is dead in the original (it clears `strings` then
// loops over the now-empty vector), faithfully reproduced.
inline std::vector<TimeNote> getStrumNotes(const json& noteData, music::Chord& currentChord,
                                           int octaveAdjustment) {
    std::vector<int> chordNotes = GuitarChord(currentChord).midi;
    std::vector<int> strings;
    if (noteData.contains("strings"))
        for (const auto& v : noteData.at("strings")) strings.push_back((int)v.get<double>());

    bool allNeg = !strings.empty();
    for (int v : strings) if (v != -1) { allNeg = false; break; }
    if (allNeg) strings.clear(); // original then loops 0 times — leaves it empty

    std::vector<TimeNote> ret;
    if (chordNotes.empty()) return ret;
    const json* offsets    = noteData.contains("offset")     ? &noteData.at("offset")     : nullptr;
    const json& durations  = noteData.at("durations");
    const json& velocities = noteData.at("velocities");
    for (int i = 0; i < (int)strings.size(); ++i) {
        double offset = (offsets && offsets->is_array() && !offsets->empty())
            ? asDouble((*offsets)[i % (int)offsets->size()]) : 0.0;
        int idx = strings[i] % (int)chordNotes.size();
        MNote note = MNote{chordNotes[idx]}.getTransposed(octaveAdjustment * 12);
        ret.push_back(TimeNote{note, offset,
            asDouble(durations[i % (int)durations.size()]),
            asInt(velocities[i % (int)velocities.size()]), TimeNote::ntTonal});
    }
    return ret;
}

// SequencerUtils.h:270-296 getFretNoises — index-based sample selection
// (Note{(int)sounds[i]}, no chord/octave transposition), velocity from data.
inline std::vector<TimeNote> getFretNoises(const json& noteData) {
    std::vector<TimeNote> ret;
    const json& sounds     = noteData.at("sounds");
    const json* offsets    = noteData.contains("offset")     ? &noteData.at("offset")     : nullptr;
    const json& durations  = noteData.at("durations");
    const json& velocities = noteData.at("velocities");
    for (int i = 0; i < (int)sounds.size(); ++i) {
        double offset = (offsets && offsets->is_array() && !offsets->empty())
            ? asDouble((*offsets)[i % (int)offsets->size()]) : 0.0;
        ret.push_back(TimeNote{MNote{asInt(sounds[i])}, offset,
            asDouble(durations[i % (int)durations.size()]),
            asInt(velocities[i % (int)velocities.size()]), TimeNote::ntFretNoise});
    }
    return ret;
}

// SequencerUtils.h:601-634 getGuitarStrums — one TimeStrums per virtualGuitarist
// note. fx events carry only a name; pitched strums carry the live chord + a
// chordPosition. `duration` stays -1 unless the note specifies one (the +offset
// in the segment loop then always lifts it off -1, so the step/fx branch in
// createSegmentClip is dead — see resolveGuitarInstrument).
// guitarGetRealNotes — SequencerUtils.h:298-328 dispatch, extended with the two
// guitar-only note types (strum/fretNoise) the shared tonal getRealNotes drops.
inline std::vector<TimeNote> guitarGetRealNotes(const json& noteData, music::Chord& currentChord,
                                                music::Chord& songKey, int octaveAdjustment,
                                                bool canUseScaleNotes, bool isScalePentatonic) {
    const std::string t = asStr(noteData.value("type", json("")));
    if (t == "strum")     return getStrumNotes(noteData, currentChord, octaveAdjustment);
    if (t == "fretNoise") return getFretNoises(noteData);
    return getRealNotes(noteData, currentChord, songKey, octaveAdjustment,
                        canUseScaleNotes, isScalePentatonic);
}

inline std::vector<TimeStrums> getGuitarStrums(const json& noteData, music::Chord currentChord) {
    TimeStrums s;
    std::string event = asStr(noteData.value("event", json("")));
    s.setTypeFromString(event);
    if (s.type == TimeStrums::fx) {
        s.fxName = event;
    } else {
        s.chord = currentChord;
        if (noteData.contains("chordPosition") && noteData.at("chordPosition").is_string())
            s.chordPosition = asInt(noteData.at("chordPosition"));
        else
            s.chordPosition = 1;
    }
    if (noteData.contains("duration")) s.duration = asDouble(noteData.at("duration"));
    return {s};
}

struct GuitarSegmentNotes {
    std::vector<TimeNote>   timeNotes;   // tonal + fretNoise (-> short/long/fret)
    std::vector<TimeStrums> timeStrums;  // virtualGuitarist (-> strums)
};

// TonalInstrument.h:35-247 processSegment, specialised for Guitar — the same bar/
// time iteration + chord-breaking as buildTonalNotes (Tonal.h), but it also
// collects virtualGuitarist strums (with the per-strum time/duration offsets,
// TonalInstrument.h:103-126) and routes strum/fretNoise note types through
// guitarGetRealNotes. Negative-time stretch is applied by the caller (it spans
// timeNotes AND timeStrums and shifts the segment clip start).
inline GuitarSegmentNotes buildGuitarSegment(const json& noteBars, const json& segmentBars,
                                             music::Chord& songKey, int octaveAdjustment,
                                             bool isScalePentatonic, double bpm, bool isAcoustic) {
    GuitarSegmentNotes out;
    int numBarsToProcess = (int)segmentBars.size();
    int numPatternBars = (int)noteBars.size();
    if (numPatternBars == 0) return out;

    for (int barIndex = 0; barIndex < numBarsToProcess; ++barIndex) {
        const json& bar = noteBars.at(barIndex % numPatternBars);
        if (!bar.is_object() || !bar.contains("notes")) continue;
        const json& notesObj = bar.at("notes");

        for (const std::string& key : timeKeysSorted(notesObj)) {
            const json& notesArray = notesObj.at(key);
            double noteTime = std::stod(key);

            for (int noteIndex = 0; noteIndex < (int)notesArray.size(); ++noteIndex) {
                const json& noteData = notesArray.at(noteIndex);
                const std::string ntype = asStr(noteData.value("type", json("")));

                if (ntype == "EDMArpeggiator") {
                    // Unexercised by the 8-genre fixtures (getEDMArpeggiatorNotes
                    // not ported) — skip rather than resolve blind.
                    continue;
                }
                if (ntype == "virtualGuitarist") {
                    music::Chord currentChord = getChordAtTime(segmentBars, barIndex, noteTime);
                    auto strums = getGuitarStrums(noteData, currentChord);
                    for (auto s : strums) {
                        double timeOffsetSec = (s.type == TimeStrums::longStrumUp ||
                                                s.type == TimeStrums::longStrumDown)
                            ? (isAcoustic ? -0.17 : -0.15) - (bpm - 110) / 10.0 * 0.01
                            : (isAcoustic ? -0.03 : -0.01);
                        double durOffsetSec = 0.1 - std::min(0.0, (bpm - 110) / 5.0 * 0.01);
                        s.start += (barIndex * 4) + noteTime + (timeOffsetSec / 60.0 * bpm);
                        s.duration += durOffsetSec / 60.0 * bpm;
                        out.timeStrums.push_back(s);
                    }
                    continue;
                }

                if (!noteData.contains("duration") || ntype == "noteAbsolute") {
                    music::Chord currentChord = getChordAtTime(segmentBars, barIndex, std::fmax(noteTime, 0.0));
                    auto realNotes = guitarGetRealNotes(noteData, currentChord, songKey, octaveAdjustment, false, false);
                    for (auto rn : realNotes) { rn.start += (barIndex * 4) + noteTime; out.timeNotes.push_back(rn); }
                } else {
                    double noteStart = noteTime;
                    double origDuration = asDouble(noteData.at("duration"));
                    double noteDuration = origDuration;
                    while (noteDuration > 0) {
                        double thisChordBreaksAt = noteStart < 0 ? 0 : noteStart;
                        music::Chord thisChord = getChordAtTime(segmentBars, barIndex, thisChordBreaksAt);
                        if (thisChord.getType() == music::Chord::invalidChord) break;
                        thisChordBreaksAt = std::trunc(thisChordBreaksAt);
                        do { thisChordBreaksAt += 1; }
                        while ((thisChordBreaksAt - noteStart) < noteDuration &&
                               thisChord == getChordAtTime(segmentBars, barIndex, thisChordBreaksAt));
                        double duration = std::fmin(thisChordBreaksAt - noteStart, origDuration);
                        json thisNoteData = noteData;
                        thisNoteData["duration"] = duration;
                        bool canUseScaleNotes =
                            std::fmod(noteStart, 1) != 0.0 &&
                            (std::fmod(noteStart, 0.5) != 0.0 || duration >= 0.5) &&
                            notesArray.size() > 1 && noteIndex == 0;
                        auto realNotes = guitarGetRealNotes(thisNoteData, thisChord, songKey,
                                                            octaveAdjustment, canUseScaleNotes, isScalePentatonic);
                        for (auto rn : realNotes) { rn.start += (barIndex * 4) + noteStart; out.timeNotes.push_back(rn); }
                        noteStart = thisChordBreaksAt;
                        noteDuration -= duration;
                    }
                }
            }
        }
    }
    return out;
}

} // namespace casperaki
