// Chord parsing + voicing math — faithful re-implementation of
// casperaki_engine's music/Chord.h (originally JUCE/te::-coupled).
//
// Drives every pitched note path: getChordSteps gives the semitone offsets of a
// chord, findNotes/findScaleNotes walk outward from a base note collecting
// chord/scale members in a given direction, and the string ctor parses
// "A#9"/"Dm"/"C" into (root, type). Must match the oracle exactly.
#pragma once

#include "Note.h"

#include <algorithm>
#include <regex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace casperaki {
namespace music {

struct Chord {
    enum ChordType {
        invalidChord = -1,
        major = 0, minor, Mdim, Mdim7, Msus2, Msus4, M7sus4, M5, Malt, Maug,
        M6, M69, M7, M7b5, Maug7, M9, M9b5, Maug9, M7b9, M7s9, M11, M9s11, M13,
        Mmaj7, Mmaj7b5, Mmaj7s5, Mmaj9, Mmaj11, Mmaj13,
        m6, m7, m7b5, m9, m69, m11, mmaj7, mmaj7b5, mmaj9, mmaj11, Madd9, madd9
    };

    enum FindDirection { up, down, center };

    Note rootNote{0};
    ChordType type = major;

    Chord(Note _rootNote, ChordType _type)
        : rootNote(_rootNote.getRootNote()), type(_type) {}

    // Chord.h:138-152 — regex ([A-Ga-g][#b]?)(type), root then type string.
    Chord(const std::string& chordName) {
        static const std::regex re("([A-Ga-g][#b]{0,1})([A-Za-z0-9#]*)");
        std::smatch match;
        if (std::regex_search(chordName, match, re) && match.size() == 3) {
            rootNote = Note{match.str(1)};
            type = getTypeFromString(match.str(2));
        } else {
            type = invalidChord;
        }
    }

    Note& getRootNote() { return rootNote; }
    ChordType& getType() { return type; }

    bool operator==(const Chord& other) const {
        return rootNote == other.rootNote && type == other.type;
    }

    static FindDirection getFindDirectionFromString(const std::string& str) {
        if (str == "up") return up;
        if (str == "down") return down;
        return center; // "center" (original asserts on anything else)
    }

    // Chord.h:120-132 — the inverse of getTypeFromString. The original iterates
    // typeTable (an unordered_map) and returns the first key matching the value,
    // which is non-deterministic for the aliased types (major/"", minor/"m",
    // sus4/"sus"); major/minor are special-cased there and GuitarChord normalises
    // "sus"->"sus4", so a fixed canonical suffix per type is faithful AND portable.
    // Long-form here (shortFormat=false) — the value form used as a GuitarChord /
    // ChordData.json lookup key.
    static std::string chordTypeToString(ChordType type, bool shortFormat = false) {
        if (type == major) return shortFormat ? "" : "major";
        if (type == minor) return shortFormat ? "m" : "minor";
        switch (type) {
            case Mdim: return "dim";       case Mdim7: return "dim7";
            case Msus2: return "sus2";     case Msus4: return "sus4";
            case M7sus4: return "7sus4";   case M5: return "5";
            case Malt: return "alt";       case Maug: return "aug";
            case M6: return "6";           case M69: return "69";
            case M7: return "7";           case M7b5: return "7b5";
            case Maug7: return "aug7";     case M9: return "9";
            case M9b5: return "9b5";       case Maug9: return "aug9";
            case M7b9: return "7b9";       case M7s9: return "7#9";
            case M11: return "11";         case M9s11: return "9#11";
            case M13: return "13";         case Mmaj7: return "maj7";
            case Mmaj7b5: return "maj7b5"; case Mmaj7s5: return "maj7#5";
            case Mmaj9: return "maj9";     case Mmaj11: return "maj11";
            case Mmaj13: return "maj13";   case m6: return "m6";
            case m7: return "m7";          case m7b5: return "m7b5";
            case m9: return "m9";          case m69: return "m69";
            case m11: return "m11";        case mmaj7: return "mmaj7";
            case mmaj7b5: return "mmaj7b5";case mmaj9: return "mmaj9";
            case mmaj11: return "mmaj11";  case Madd9: return "add9";
            case madd9: return "madd9";
            default: return "";
        }
    }

    static ChordType getTypeFromString(const std::string& typeStr) {
        const auto& t = typeTable();
        auto it = t.find(typeStr);
        if (it == t.end()) return major; // original asserts; valid input never misses
        return it->second;
    }

    // Chord.h:178-214. Walk outward from baseNote collecting chord members.
    // center alternates 0,-1,+1,-2,+2,... then sorts ascending; up/down step ±1.
    std::vector<Note> findNotes(Note baseNote, FindDirection direction, int numberOfNotes) {
        std::vector<Note> notes;
        int noteOffset = 0;
        while ((int)notes.size() < numberOfNotes) {
            Note thisNote = baseNote.getTransposed(noteOffset);
            if (isNoteInChord(thisNote)) notes.push_back(thisNote);
            switch (direction) {
                case center:
                    noteOffset = noteOffset * -1;
                    if (noteOffset <= 0) noteOffset--;
                    break;
                case up: noteOffset++; break;
                case down: noteOffset--; break;
            }
        }
        if (direction == center)
            std::sort(notes.begin(), notes.end());
        return notes;
    }

    // Chord.h:216-252. Same shape but using scale membership; note the center
    // increment differs from findNotes (0,+1,-1,+2,-2,...).
    std::vector<Note> findScaleNotes(Note baseNote, FindDirection direction,
                                     int numberOfNotes, bool isScalePentatonic = false) {
        std::vector<Note> notes;
        int noteOffset = 0;
        while ((int)notes.size() < numberOfNotes) {
            Note thisNote = baseNote.getTransposed(noteOffset);
            if (isNoteInScale(thisNote, isScalePentatonic)) notes.push_back(thisNote);
            switch (direction) {
                case center:
                    noteOffset = noteOffset * -1;
                    if (noteOffset >= 0) noteOffset++;
                    break;
                case up: noteOffset++; break;
                case down: noteOffset--; break;
            }
        }
        if (direction == center)
            std::sort(notes.begin(), notes.end());
        return notes;
    }

    // Chord.h:254-257
    Note findNextNote(Note baseNote, FindDirection direction, int increment = 1) {
        return findNotes(baseNote.getTransposed(direction == up ? 1 : -1),
                         direction, increment)[increment - 1];
    }

    bool isNoteInChord(Note note) {
        if (type == invalidChord) throw std::invalid_argument("Invalid chord type");
        Note noteRoot = note.getRootNote();
        for (int step : getChordSteps())
            if (rootNote.getTransposed(step).isSameRoot(noteRoot)) return true;
        return false;
    }

    bool isNoteInScale(Note note, bool isScalePentatonic = false) {
        if (type == invalidChord) throw std::invalid_argument("Invalid chord type");
        Note noteRoot = note.getRootNote();
        std::vector<int> steps = getScaleSteps();
        if (isScalePentatonic) {
            steps.erase(std::remove(steps.begin(), steps.end(), 5), steps.end());
            steps.erase(std::remove(steps.begin(), steps.end(), 11), steps.end());
        }
        for (int step : steps)
            if (rootNote.getTransposed(step).isSameRoot(noteRoot)) return true;
        return false;
    }

private:
    static const std::unordered_map<std::string, ChordType>& typeTable() {
        static const std::unordered_map<std::string, ChordType> t = {
            {"major", major}, {"", major}, {"minor", minor}, {"m", minor},
            {"dim", Mdim}, {"dim7", Mdim7}, {"sus2", Msus2}, {"sus4", Msus4},
            {"sus", Msus4}, {"7sus4", M7sus4}, {"5", M5}, {"alt", Malt},
            {"aug", Maug}, {"6", M6}, {"69", M69}, {"7", M7}, {"7b5", M7b5},
            {"aug7", Maug7}, {"9", M9}, {"9b5", M9b5}, {"aug9", Maug9},
            {"7b9", M7b9}, {"7#9", M7s9}, {"11", M11}, {"9#11", M9s11},
            {"13", M13}, {"maj7", Mmaj7}, {"maj7b5", Mmaj7b5}, {"maj7#5", Mmaj7s5},
            {"maj9", Mmaj9}, {"maj11", Mmaj11}, {"maj13", Mmaj13}, {"m6", m6},
            {"m7", m7}, {"m7b5", m7b5}, {"m9", m9}, {"m69", m69}, {"m11", m11},
            {"mmaj7", mmaj7}, {"mmaj7b5", mmaj7b5}, {"mmaj9", mmaj9},
            {"mmaj11", mmaj11}, {"add9", Madd9}, {"madd9", madd9}};
        return t;
    }

    std::vector<int> getChordSteps() {
        switch (type) {
            case major:    return {0, 4, 7};
            case minor:    return {0, 3, 7};
            case Mdim:     return {0, 3, 6};
            case Mdim7:    return {0, 3, 6, 9};
            case Msus2:    return {0, 2, 7};
            case Msus4:    return {0, 5, 7};
            case M7sus4:   return {0, 5, 7, 10};
            case M5:       return {0, 7};
            case Malt:     return {0, 4, 6};
            case Maug:     return {0, 4, 8};
            case M6:       return {0, 4, 7, 9};
            case M69:      return {0, 2, 4, 7, 9};
            case M7:       return {0, 4, 7, 10};
            case M7b5:     return {0, 4, 6, 10};
            case Maug7:    return {0, 4, 8, 10};
            case M9:       return {0, 2, 4, 7, 10};
            case M9b5:     return {0, 2, 4, 6, 10};
            case Maug9:    return {0, 2, 4, 8, 10};
            case M7b9:     return {0, 1, 4, 7, 10};
            case M7s9:     return {0, 3, 4, 7, 10};
            case M11:      return {0, 4, 5, 10};
            case M9s11:    return {0, 2, 4, 6, 10};
            case M13:      return {0, 4, 5, 7, 9, 10};
            case Mmaj7:    return {0, 4, 7, 11};
            case Mmaj7b5:  return {0, 4, 6, 11};
            case Mmaj7s5:  return {0, 4, 8, 11};
            case Mmaj9:    return {0, 2, 4, 7, 11};
            case Mmaj11:   return {0, 4, 5, 7, 11};
            case Mmaj13:   return {0, 4, 5, 9, 11};
            case m6:       return {0, 3, 7, 9};
            case m7:       return {0, 3, 7, 10};
            case m7b5:     return {0, 3, 6, 10};
            case m9:       return {0, 2, 3, 7, 10};
            case m69:      return {0, 2, 3, 7, 9};
            case m11:      return {0, 2, 3, 5, 10};
            case mmaj7:    return {0, 3, 7, 11};
            case mmaj7b5:  return {0, 3, 6, 11};
            case mmaj9:    return {0, 2, 3, 11};
            case mmaj11:   return {0, 3, 5, 7, 11};
            case Madd9:    return {0, 2, 4, 7};
            case madd9:    return {0, 2, 3, 7};
            case invalidChord:
            default:       return {};
        }
    }

    std::vector<int> getScaleSteps() {
        switch (type) {
            case major: case Mdim: case Msus2: case Msus4: case M5: case M6:
            case M69: case Mmaj7: case Mmaj9: case Mmaj11: case Mmaj13: case Madd9:
                return {0, 2, 4, 5, 7, 9, 11};
            case M7: case M9: case M11: case M13: case M7sus4:
                return {0, 2, 4, 5, 7, 9, 10};
            case M9s11: case Malt: case M9b5: case M7b5:
                return {0, 2, 4, 6, 7, 9, 10};
            case Maug: case Maug7: case Maug9:
                return {0, 2, 4, 5, 7, 8, 10};
            case Mmaj7b5: case Mmaj7s5:
                return {0, 2, 4, 6, 8, 9, 11};
            case Mdim7:
                return {0, 2, 3, 5, 6, 9, 11};
            case M7s9: case M7b9:
                return {0, 1, 3, 4, 7, 9, 10};
            case minor: case m6: case m69: case mmaj9: case mmaj11: case madd9:
            case mmaj7:
                return {0, 2, 3, 5, 7, 9, 11};
            case mmaj7b5:
                return {0, 2, 3, 5, 6, 8, 11};
            case m7b5:
                return {0, 2, 3, 5, 6, 8, 10};
            case m7: case m9: case m11:
                return {0, 2, 3, 5, 7, 9, 10};
            case invalidChord:
            default:
                return {};
        }
    }
};

} // namespace music
} // namespace casperaki
