// Tonal lane resolution — re-implements casperaki_engine's TonalInstrument
// (instruments/TonalInstrument.h) + the note-builders in SequencerUtils.h and
// the Synths/Bass createSegmentClip overrides. Drives every Synths-class
// instrument (leadSynths/synths/keys/popBrass/popStrings/orchestral/vocals) and
// Bass.
//
// Port order = PORTING-MAP.md step 1. The fixtures use four tonal note types —
// note / noteAbsolute / chord / noteRelative — plus the chord-breaking pass
// (TonalInstrument.h:141-189) and the sustain tail (+2.0 beats, Synths.h:54 /
// Bass.h:55). Velocity is VelocityMode::beat (SequencerUtils.h:643-651), a pure
// function of the note's beat position — no RNG — so pitch, timing AND velocity
// hard-assert exact against the oracle.
#pragma once

#include "ResolvedEvents.h"
#include "Random.h"
#include "music/Chord.h"
#include "../vendor/json.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <string>
#include <vector>

namespace casperaki {

using nlohmann::json;
using music::Chord;
using MNote = music::Note; // the music-theory note (vs. the IR `Note` in ResolvedEvents.h)

// A note before it lands in a clip; mirrors SequencerUtils.h TimeNote.
// `kind` mirrors TimeNote::Type (tonal vs fretNoise) — only the Guitar lane
// distinguishes them (fret noises route to their own track and skip the
// randomised-velocity / overlap-shortener path); every other lane is tonal.
struct TimeNote {
    enum Kind { ntTonal, ntFretNoise };
    MNote note;
    double start = 0;
    double duration = 0;
    int velocity = 65;
    Kind kind = ntTonal;
};

// SequencerUtils.h:25-29
enum VelocityMode { vmNone, vmBeat, vmRandomised };

// JSON values for note fields arrive as numbers; juce read them via
// toString().getDoubleValue()/(int), which also tolerates string-encoded
// numbers. Mirror that leniency.
inline double asDouble(const json& v) {
    if (v.is_number()) return v.get<double>();
    if (v.is_string()) { try { return std::stod(v.get<std::string>()); } catch (...) { return 0.0; } }
    return 0.0;
}
inline int asInt(const json& v) {
    if (v.is_number()) return (int)v.get<double>();
    if (v.is_string()) { try { return std::stoi(v.get<std::string>()); } catch (...) { return 0; } }
    return 0;
}
inline std::string asStr(const json& v) {
    return v.is_string() ? v.get<std::string>() : std::string();
}

// SequencerUtils.h:330-341. Chords live on the *structure* bars (4 per bar);
// time rolls past bar boundaries. Out of range -> invalid chord (segment over).
inline Chord getChordAtTime(const json& segmentBars, int barIndex, double time) {
    while (time >= 4.0) { time -= 4.0; barIndex++; }
    if (barIndex >= (int)segmentBars.size())
        return Chord(MNote(0), Chord::invalidChord);
    const json& chords = segmentBars.at(barIndex).at("chords");
    return Chord(chords[(int)std::trunc(time)].get<std::string>());
}

// SequencerUtils.h:105-112 — transpose the written note onto the chord root.
inline std::vector<TimeNote> getSimpleNote(const json& noteData, Chord& currentChord, int octaveAdjustment) {
    int delta = MNote{"C"}.deltaTo(currentChord.getRootNote(), true);
    delta += 12 * octaveAdjustment;
    MNote note = MNote{asStr(noteData.at("note"))}.getTransposed(delta);
    return {TimeNote{note, 0, asDouble(noteData.value("duration", json(0)))}};
}

// SequencerUtils.h:114-158 — chord voicing per chordType, anchored to the song
// key, then shifted by the per-instrument octave correction.
inline std::vector<TimeNote> getChordNotes(const json& noteData, Chord& currentChord,
                                           Chord& songKey, int octaveAdjustment) {
    auto removeOddNotes = [](const std::vector<MNote>& notes) {
        std::vector<MNote> ret;
        for (size_t i = 0; i < notes.size(); i += 2) ret.push_back(notes[i]);
        return ret;
    };

    const std::string chordType = asStr(noteData.at("chordType"));
    std::vector<MNote> notes;
    std::string songKeyBase = songKey.getRootNote().toString(false);
    if (chordType == "pianoLeftHand")
        notes = currentChord.findNotes(MNote{songKeyBase + "3"}, Chord::up, 3);
    else if (chordType == "pianoRightHand" || chordType == "oneOctaveHigh")
        notes = currentChord.findNotes(MNote{songKeyBase + "5"}, Chord::down, 3);
    else if (chordType == "oneOctaveMid")
        notes = currentChord.findNotes(MNote{songKeyBase + "4"}, Chord::down, 3);
    else if (chordType == "oneOctaveLow")
        notes = currentChord.findNotes(MNote{songKeyBase + "3"}, Chord::down, 3);
    else if (chordType == "twoOctavesHigh")
        notes = removeOddNotes(currentChord.findNotes(MNote{songKeyBase + "5"}, Chord::down, 6));
    else if (chordType == "twoOctavesMid")
        notes = removeOddNotes(currentChord.findNotes(MNote{songKeyBase + "4"}, Chord::down, 6));
    else if (chordType == "twoOctavesLow")
        notes = removeOddNotes(currentChord.findNotes(MNote{songKeyBase + "3"}, Chord::down, 6));
    else
        throw std::runtime_error("Unknown chord type: " + chordType);

    std::vector<TimeNote> ret;
    double duration = asDouble(noteData.value("duration", json(0)));
    for (auto& note : notes)
        ret.push_back(TimeNote{note.getTransposed(octaveAdjustment * 12), 0, duration});
    return ret;
}

// SequencerUtils.h:180-218 — note relative to the chord (two encodings).
inline std::vector<TimeNote> getRelativeNote(const json& noteData, Chord& currentChord,
                                             int octaveAdjustment, bool canUseScaleNotes = false,
                                             bool isScalePentatonic = false) {
    double duration = asDouble(noteData.value("duration", json(0)));
    if (noteData.contains("distanceFromMiddleC")) {
        MNote baseNote = MNote{60 + asInt(noteData.at("distanceFromMiddleC")) + octaveAdjustment * 12};
        MNote relativeNote = canUseScaleNotes
            ? currentChord.findScaleNotes(baseNote, Chord::center, 1, isScalePentatonic)[0]
            : currentChord.findNotes(baseNote, Chord::center, 1)[0];
        return {TimeNote{relativeNote, 0, duration}};
    }

    MNote baseNote = MNote{currentChord.getRootNote()}.getTransposed(asInt(noteData.at("octave")) * 12);
    int noteIdx = asInt(noteData.at("note"));
    MNote relativeNote = currentChord.findNotes(
        baseNote, Chord::getFindDirectionFromString(asStr(noteData.at("direction"))),
        noteIdx + 1)[noteIdx];

    int offset = asInt(noteData.at("offset"));
    if (offset > 0)
        relativeNote = currentChord.findScaleNotes(relativeNote.getTransposed(offset), Chord::up, 1, isScalePentatonic)[0];
    else if (offset < 0)
        relativeNote = currentChord.findScaleNotes(relativeNote.getTransposed(offset), Chord::down, 1, isScalePentatonic)[0];

    return {TimeNote{relativeNote, 0, duration}};
}

// SequencerUtils.h:160-178 — simple chord arpeggio (not present in the 8-genre
// fixtures, but cheap and self-contained, so ported for completeness).
inline std::vector<TimeNote> getArpeggioNotes(const json& noteData, Chord& currentChord, int octaveAdjustment) {
    MNote baseNote = MNote{std::string("C") + asStr(noteData.value("octave", json("")))};
    baseNote = baseNote.getTransposed(octaveAdjustment * 12);
    int noteIndex = asInt(noteData.at("note"));
    std::vector<MNote> chordNotes = currentChord.findNotes(
        baseNote, Chord::getFindDirectionFromString(asStr(noteData.at("direction"))), noteIndex + 1);
    return {TimeNote{chordNotes[noteIndex], 0, asDouble(noteData.value("duration", json(0)))}};
}

// SequencerUtils.h:298-328 — note-type dispatch. Guitar paths (strum/fretNoise/
// virtualGuitarist) and EDMArpeggiator are handled elsewhere; here we cover the
// tonal set and drop anything unknown (returns empty), matching the original's
// "note type not implemented" fall-through.
inline std::vector<TimeNote> getRealNotes(const json& noteData, Chord& currentChord, Chord& songKey,
                                          int octaveAdjustment = 0, bool canUseScaleNotes = false,
                                          bool isScalePentatonic = false) {
    const std::string noteType = asStr(noteData.value("type", json("")));
    if (noteType == "note") return getSimpleNote(noteData, currentChord, octaveAdjustment);
    if (noteType == "noteAbsolute") { Chord c{"C"}; return getSimpleNote(noteData, c, octaveAdjustment); }
    if (noteType == "chord") return getChordNotes(noteData, currentChord, songKey, octaveAdjustment);
    if (noteType == "arpeggio") return getArpeggioNotes(noteData, currentChord, octaveAdjustment);
    if (noteType == "noteRelative") return getRelativeNote(noteData, currentChord, octaveAdjustment, canUseScaleNotes, isScalePentatonic);
    return {};
}

// The note keys in a bar ("0.0", "1.5", ...) are iterated in time order by the
// original (juce DynamicObject preserves insertion order; the brain emits them
// sorted). nlohmann's object is key-sorted, so recover numeric order explicitly.
inline std::vector<std::string> timeKeysSorted(const json& notesObj) {
    std::vector<std::string> keys;
    for (auto it = notesObj.begin(); it != notesObj.end(); ++it) keys.push_back(it.key());
    std::stable_sort(keys.begin(), keys.end(), [](const std::string& a, const std::string& b) {
        return std::stod(a) < std::stod(b);
    });
    return keys;
}

// TonalInstrument.h:78-193 — build the per-segment note list from the (pattern
// or override) bars, breaking notes at chord changes. `noteBars` carries the
// notes; `segmentBars` carries the chords + the bar count.
inline std::vector<TimeNote> buildTonalNotes(const json& noteBars, const json& segmentBars,
                                             Chord& songKey, int octaveAdjustment,
                                             bool isScalePentatonic) {
    std::vector<TimeNote> timeNotes;
    int numBarsToProcess = (int)segmentBars.size();
    int numPatternBars = (int)noteBars.size();
    if (numPatternBars == 0) return timeNotes;

    for (int barIndex = 0; barIndex < numBarsToProcess; barIndex++) {
        int patternBarIndex = barIndex % numPatternBars;
        const json& bar = noteBars.at(patternBarIndex);
        if (!bar.is_object() || !bar.contains("notes")) continue;
        const json& notesObj = bar.at("notes");

        for (const std::string& key : timeKeysSorted(notesObj)) {
            const json& notesArray = notesObj.at(key);
            double noteTime = std::stod(key);

            for (int noteIndex = 0; noteIndex < (int)notesArray.size(); noteIndex++) {
                const json& noteData = notesArray.at(noteIndex);
                const std::string ntype = asStr(noteData.value("type", json("")));

                // Guitar/EDM paths are resolved by their own lanes — skip here.
                if (ntype == "EDMArpeggiator" || ntype == "virtualGuitarist") continue;

                if (!noteData.contains("duration") || ntype == "noteAbsolute") {
                    // add notes as they are — no chord breaking
                    Chord currentChord = getChordAtTime(segmentBars, barIndex, std::fmax(noteTime, 0.0));
                    auto realNotes = getRealNotes(noteData, currentChord, songKey, octaveAdjustment);
                    for (auto rn : realNotes) {
                        rn.start += (barIndex * 4) + noteTime;
                        timeNotes.push_back(rn);
                    }
                } else {
                    // break the note if the chord changes (TonalInstrument.h:141-189)
                    double noteStart = noteTime;
                    double origDuration = asDouble(noteData.at("duration"));
                    double noteDuration = origDuration;

                    while (noteDuration > 0) {
                        double thisChordBreaksAt = noteStart < 0 ? 0 : noteStart;
                        Chord thisChord = getChordAtTime(segmentBars, barIndex, thisChordBreaksAt);
                        if (thisChord.getType() == Chord::invalidChord) break;

                        thisChordBreaksAt = std::trunc(thisChordBreaksAt);
                        do {
                            thisChordBreaksAt += 1;
                        } while ((thisChordBreaksAt - noteStart) < noteDuration &&
                                 thisChord == getChordAtTime(segmentBars, barIndex, thisChordBreaksAt));

                        double duration = std::fmin(thisChordBreaksAt - noteStart, origDuration);
                        json thisNoteData = noteData;
                        thisNoteData["duration"] = duration;

                        // tools.js:16881 — scale notes allowed only off-beat, with
                        // enough length, in a multi-note slot, on the first note.
                        bool canUseScaleNotes =
                            std::fmod(noteStart, 1) != 0.0 &&
                            (std::fmod(noteStart, 0.5) != 0.0 || duration >= 0.5) &&
                            notesArray.size() > 1 &&
                            noteIndex == 0;

                        auto realNotes = getRealNotes(thisNoteData, thisChord, songKey,
                                                      octaveAdjustment, canUseScaleNotes, isScalePentatonic);
                        for (auto rn : realNotes) {
                            rn.start += (barIndex * 4) + noteStart;
                            timeNotes.push_back(rn);
                        }

                        noteStart = thisChordBreaksAt;
                        noteDuration -= duration;
                    }
                }
            }
        }
    }
    return timeNotes;
}

// SequencerUtils.h:636-670 — add a note to a clip's note list. Computes the
// beat-mode velocity and applies the same-pitch overlap shortener against notes
// already in this clip (so a held note is trimmed when the next onset of the
// same pitch arrives). `clip` is the destination IR clip.
inline void addNoteToClip(Clip& clip, const TimeNote& tn, VelocityMode mode, Random* rng = nullptr) {
    static const double normalisedVelocities[4] = {0.9, 0.7, 0.5, 0.3};
    int velocity = tn.velocity;
    if (mode == vmBeat) {
        if (std::fmod(tn.start, 4.0) == 0.0) velocity = (int)(normalisedVelocities[0] * 127);
        else if (std::fmod(tn.start, 2.0) == 0.0) velocity = (int)(normalisedVelocities[1] * 127);
        else if (std::fmod(tn.start, 1.0) == 0.0) velocity = (int)(normalisedVelocities[2] * 127);
        else velocity = (int)(normalisedVelocities[3] * 127);
    } else if (mode == vmRandomised && rng) {
        // SequencerUtils.h:653 — humanise around the base velocity. Integer
        // division truncates toward zero (range [-13, +12]). The native golden
        // draws this from a clock-seeded global juce::Random, so the value is not
        // reproducible against it (velocity is validated statistically for the
        // Guitar tonal tracks until the golden is regenerated determinised —
        // docs/61 §2 / Phase 2); we still draw in faithful order so the engine is
        // deterministic run-to-run and Phase-2-ready.
        velocity += (rng->nextInt(127) - 65) / 5;
    }

    for (int i = (int)clip.notes.size(); --i >= 0;) {
        Note& nn = clip.notes[i];
        if (nn.n == tn.note.midiNote && nn.startBeat < tn.start &&
            (nn.startBeat + nn.lenBeats) > tn.start) {
            nn.lenBeats = tn.start - nn.startBeat;
        }
    }

    clip.notes.push_back(Note{tn.note.midiNote, tn.note.toString(),
                              tn.start, tn.duration, velocity});
}

} // namespace casperaki
