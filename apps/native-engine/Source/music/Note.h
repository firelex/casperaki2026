//
// Created by Tiago Alves on 13/06/2022.
//

#pragma once

#include <JuceHeader.h>
#include "../common.h"

/* note utils */

inline int getMidiNoteNumber(juce::String noteName) {
    static const juce::Array<j::String> sharpNoteNames ( "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" );
    static const juce::Array<j::String> flatNoteNames ("C", "DB", "D", "EB", "E", "F", "GB", "G", "AB", "A", "BB", "B" );

    int octave = (noteName[noteName.length() - 1]) - (wchar_t)'0';

    if (octave >= 0 && octave <= 9) {
        juce::String notePart = noteName.substring(0, noteName.length() - 1).toUpperCase();

        int noteNumber = sharpNoteNames.indexOf(notePart);
        if ( noteNumber == -1 ) noteNumber = flatNoteNames.indexOf(notePart);
        jassert(noteNumber > -1);

        return noteNumber + octave * 12 + 12;
    } else {
        juce::String notePart = noteName.toUpperCase();
        int noteNumber = sharpNoteNames.indexOf(notePart);
        if ( noteNumber == -1 ) noteNumber = flatNoteNames.indexOf(notePart);
        jassert(noteNumber > -1);

        return noteNumber;
    }
}

inline juce::String getMidiNoteName(int noteNumber, bool includeOctaveNumber = true) {
    return juce::MidiMessage::getMidiNoteName(noteNumber, true, includeOctaveNumber, 4);
}

struct Note {

public:
    Note(): midiNote(0) { }

    Note(int _midiNote): midiNote(_midiNote) { }

    Note (juce::String noteName) {
        midiNote = getMidiNoteNumber(noteName);
    }

    int toInt() {
        return midiNote;
    }

    juce::String toString(bool includeOctaveNumber = true) {
        return getMidiNoteName(midiNote, includeOctaveNumber);
    }

    Note getTransposed(int transpose) {
        return Note{midiNote + transpose};
    }

    Note getRootNote() {
        return Note{midiNote % 12};
    }

    bool isSameRoot (Note &other) {
        return (midiNote % 12) == (other.midiNote % 12);
    }

    int deltaTo(Note &other, bool compareRoots = false ) {
        int delta = other.midiNote - midiNote;

        if ( compareRoots ) {
            delta = delta % 12;
            if (delta > 6) delta -= 12;
            if (delta < -6) delta += 12;
        }

        return delta;
    }

    bool operator == (const Note &other) const { return midiNote == other.midiNote; }

    bool operator < (const Note &other) const { return midiNote < other.midiNote; }

    static j::String noteArrayToString(j::Array<Note> notes) {
        j::String s{};
        for(auto it = notes.begin(); it != notes.end(); it++)
            s << " " << (*it).toString();

        return s;
    }

    int midiNote;
};

inline j::String noteArrayToString(j::Array<Note> notes) {
    j::String s{};
    for(auto it = notes.begin(); it != notes.end(); it++)
        s << " " << (*it).toString();

    return s;
}