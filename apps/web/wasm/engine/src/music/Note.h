// MIDI note math — faithful re-implementation of casperaki_engine's
// music/Note.h (te::/JUCE-coupled in the original, portable here).
//
// The two free functions mirror the JUCE primitives the engine leaned on:
//   - getMidiNoteNumber : note-name string -> MIDI number (Note.h:12-34)
//   - getMidiNoteName   : MIDI number -> note-name string, sharps, middle C = C4
//     (juce::MidiMessage::getMidiNoteName(n, useSharps=true, octave, 4))
// Pitch/timing are hard-asserted against the resolution oracle, so these have
// to match byte-for-byte (note names included).
#pragma once

#include <array>
#include <cstdlib>
#include <string>

namespace casperaki {
namespace music {

// Sharp/flat spellings used by the engine. The flat table is upper-cased to
// match the original lookup (notePart.toUpperCase()).
inline const std::array<std::string, 12>& sharpNoteNames() {
    static const std::array<std::string, 12> n = {
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};
    return n;
}
inline const std::array<std::string, 12>& flatNoteNames() {
    static const std::array<std::string, 12> n = {
        "C", "DB", "D", "EB", "E", "F", "GB", "G", "AB", "A", "BB", "B"};
    return n;
}

inline std::string toUpper(std::string s) {
    for (char& c : s) c = (char)std::toupper((unsigned char)c);
    return s;
}

inline int indexOfNote(const std::array<std::string, 12>& tbl, const std::string& p) {
    for (int i = 0; i < 12; ++i)
        if (tbl[i] == p) return i;
    return -1;
}

// note-name -> MIDI number. Mirrors Note.h:12-34: the final character is the
// octave digit when in 0..9 (then notePart = the rest, returns idx+octave*12+12,
// so "C4" = 60); otherwise the whole string is the note class (returns idx,
// used for chord roots like "A#" / "Bb").
inline int getMidiNoteNumber(const std::string& noteName) {
    if (noteName.empty()) return 0;
    int octave = noteName.back() - '0';
    if (octave >= 0 && octave <= 9) {
        std::string notePart = toUpper(noteName.substr(0, noteName.size() - 1));
        int n = indexOfNote(sharpNoteNames(), notePart);
        if (n == -1) n = indexOfNote(flatNoteNames(), notePart);
        return n + octave * 12 + 12;
    }
    std::string notePart = toUpper(noteName);
    int n = indexOfNote(sharpNoteNames(), notePart);
    if (n == -1) n = indexOfNote(flatNoteNames(), notePart);
    return n;
}

// MIDI number -> note-name. Replicates juce::MidiMessage::getMidiNoteName with
// useSharps=true and octaveNumForMiddleC=4: name = sharp[n%12] + (n/12 - 1),
// guarded to 0..127 (returns "" otherwise, as JUCE does).
inline std::string getMidiNoteName(int noteNumber, bool includeOctaveNumber = true) {
    if (noteNumber >= 0 && noteNumber < 128) {
        std::string s = sharpNoteNames()[noteNumber % 12];
        if (includeOctaveNumber) s += std::to_string(noteNumber / 12 + (4 - 5));
        return s;
    }
    return "";
}

struct Note {
    int midiNote = 0;

    Note() = default;
    Note(int n) : midiNote(n) {}
    Note(const std::string& noteName) : midiNote(getMidiNoteNumber(noteName)) {}

    int toInt() const { return midiNote; }
    std::string toString(bool includeOctaveNumber = true) const {
        return getMidiNoteName(midiNote, includeOctaveNumber);
    }
    Note getTransposed(int transpose) const { return Note{midiNote + transpose}; }
    Note getRootNote() const { return Note{midiNote % 12}; }
    bool isSameRoot(const Note& other) const {
        return (midiNote % 12) == (other.midiNote % 12);
    }
    // Note.h:71-80. compareRoots collapses to the nearest direction within an
    // octave (delta in (-6, 6]).
    int deltaTo(const Note& other, bool compareRoots = false) const {
        int delta = other.midiNote - midiNote;
        if (compareRoots) {
            delta = delta % 12;
            if (delta > 6) delta -= 12;
        }
        return delta;
    }
    bool operator==(const Note& other) const { return midiNote == other.midiNote; }
    bool operator<(const Note& other) const { return midiNote < other.midiNote; }
};

} // namespace music
} // namespace casperaki
