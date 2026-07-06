//
// Created by Tiago Alves on 15/06/2022.
//

#pragma once

#include "../music/Chord.h"
#include "../CasperakiSamplerPlugin.h"

//namespace te = tracktion_engine;

struct TimeNote {
    enum Type {
        tonal,
        fretNoise
    };

    Note note{};
    double start;
    double duration;
    int velocity = 65;
    Type type = tonal;
};

enum VelocityMode {
    none,
    beat,
    randomised
};

struct TimeStrums {
    enum Type {
        shortStrumUp,
        shortStrumDown,
        longStrumUp,
        longStrumDown,
        fx
    };

    Chord chord{"C"};
    int chordPosition = 1;
    j::String fxName{};
    double start;
    double duration = -1;
    Type type = shortStrumUp;
    int velocity = 65;

    inline static const j::String TypeStrings[] = { "chordShortStrumUp", "chordShortStrumDown", "chordLongStrumUp", "chordLongStrumDown", "fx" };
    const j::String typeAsString() const
    {
        return TypeStrings[type];
    }

    void setTypeFromString (const j::String& typeString)
    {
        for (int i = 0; i < 4; i++)
        {
            if (typeString == TypeStrings[i])
            {
                type = (Type) i;
                return;
            }
        }
        if (typeString.startsWith ("fx"))
        {
            type = TimeStrums::Type::fx;
            return;
        }
        throw std::invalid_argument("Invalid type string");
    }
};

// docs/61 §2 + docs/63 §7 (casperaki WASM render port): the engine's ONLY
// run-to-run non-determinism was this RNG being default-constructed, which
// seeds juce::Random from the wall clock and makes the velocity-humanization
// grid (SequencerUtils.h ~line 653) differ every render. Seed it to a FIXED
// value so a given song.json renders bit-reproducibly — the precondition for a
// near-exact WAV-null parity oracle against the WASM port. Seed 1 matches the
// WASM engine's Random() default (apps/web/wasm/engine/src/Random.h) so the two
// velocity streams align for the same draw order. (rand()%10 in Sequencer.cpp
// and the AirWindows fpd dither are already seed-1-stable: no srand() anywhere.)
inline j::Random randomNumberGenerator{ (j::int64) 1 };

inline juce::var getInstrumentPattern(juce::var& songData, int instrumentId)
{
    try
    {
        auto patterns = (*songData["patterns"].getArray())[0]["pattern"].getArray();

        for (auto pattern : *patterns)
        {
            if ((int)pattern["instrumentId"] == instrumentId)
            {
                juce::Logger::writeToLog("Found PATTERN FOR " + juce::String(instrumentId) + ": " + juce::String(pattern["instrumentName"].toString()));
                return pattern;
            }
        }
    }
    catch (std::exception& e)
    {
        // Handle the exception
        juce::Logger::writeToLog("Exception occurred: " + juce::String (e.what()));
    }
    catch (...)
    {
        // Handle any other unknown exception
        juce::Logger::writeToLog("Unknown exception occurred.");
    }

    // Return a default value indicating failure
    return juce::var::undefined();
}

inline j::Array<TimeNote> getSimpleNote (j::var &noteData, Chord &currentChord, int octaveAdjustment)
{
    int delta = Note{"C"}.deltaTo (currentChord.getRootNote (), true);
    delta += 12 * octaveAdjustment;

    Note note = Note{noteData["note"].toString ()}.getTransposed (delta);
    return j::Array<TimeNote>{TimeNote{note, 0, noteData["duration"].toString ().getDoubleValue ()}};
}

inline j::Array<TimeNote> getChordNotes (j::var &noteData, Chord &currentChord, Chord &songKey, int octaveAdjustment = 0)
{
    auto removeOddNotes = [] (j::Array<Note> notes)
    {
        j::Array<Note> ret{};
        for (int i = 0; i < notes.size (); i += 2)
            ret.add (notes[i]);
        return ret;
    };

    const j::String chordType = noteData["chordType"].toString ();
    j::Array<Note> notes;
    j::String songKeyBase = songKey.getRootNote ().toString (false);
    if (chordType == "pianoLeftHand")
        notes = currentChord.findNotes (Note{songKeyBase + "3"}, Chord::FindDirection::up, 3);
    else if (chordType == "pianoRightHand" || chordType == "oneOctaveHigh")
        notes = currentChord.findNotes (Note{songKeyBase + "5"}, Chord::FindDirection::down, 3);
    else if (chordType == "oneOctaveMid")
        notes = currentChord.findNotes (Note{songKeyBase + "4"}, Chord::FindDirection::down, 3);
    else if (chordType == "oneOctaveLow")
        notes = currentChord.findNotes (Note{songKeyBase + "3"}, Chord::FindDirection::down, 3);
    else if (chordType == "twoOctavesHigh")
        notes = removeOddNotes (currentChord.findNotes (Note{songKeyBase + "5"}, Chord::FindDirection::down, 6));
    else if (chordType == "twoOctavesMid")
        notes = removeOddNotes (currentChord.findNotes (Note{songKeyBase + "4"}, Chord::FindDirection::down, 6));
    else if (chordType == "twoOctavesLow")
        notes = removeOddNotes (currentChord.findNotes (Note{songKeyBase + "3"}, Chord::FindDirection::down, 6));
    else
        throw std::runtime_error ("Unknown chord type: " + chordType.toStdString ());

    j::Array<TimeNote> ret{};
    double duration = noteData["duration"].toString ().getDoubleValue ();
    for (auto note: notes)
    {
        // Apply the per-instrument octave correction, matching the other
        // note paths (getSimpleNote/getArpeggioNotes/getRelativeNote/
        // getEDMArpeggiatorNotes) and the legacy HelperClass chord-voicing
        // loop (noteIndex += octaveAdjustment * 12). Without this, chord
        // events silently dropped the adjustment while single-note events
        // applied it — leaving the same instrument half-corrected.
        ret.add (TimeNote{note.getTransposed (octaveAdjustment * 12), 0, duration});
    }

    return ret;
}

inline j::Array<TimeNote> getArpeggioNotes (j::var &noteData, Chord &currentChord, int octaveAdjustment)
{
    j::String baseNoteStr{"C"};
    baseNoteStr << noteData["octave"].toString ();
    Note baseNote = Note{baseNoteStr};

    baseNote = baseNote.getTransposed (octaveAdjustment * 12);

    int noteIndex = (int) noteData["note"];

    j::Array<Note> chordNotes = currentChord.findNotes (
        baseNote,
        Chord::getFindDirectionFromString (noteData["direction"].toString ()),
        noteIndex + 1);

    return j::Array<TimeNote>{
        TimeNote{chordNotes[noteIndex], 0, noteData["duration"].toString ().getDoubleValue ()}
    };
}

inline j::Array<TimeNote> getRelativeNote (j::var &noteData, Chord &currentChord, int octaveAdjustment, bool canUseScaleNotes = false, bool isScalePentatonic = false)
{
    if (noteData.hasProperty ("distanceFromMiddleC"))
    {
        Note baseNote = Note{60 + (int) noteData["distanceFromMiddleC"] + octaveAdjustment * 12};
        Note relativeNote;
        if (canUseScaleNotes)
            relativeNote = currentChord.findScaleNotes (baseNote, Chord::FindDirection::center, 1, isScalePentatonic)[0];
        else
            relativeNote = currentChord.findNotes (baseNote, Chord::FindDirection::center, 1)[0];

        return j::Array<TimeNote>{TimeNote{relativeNote, 0, noteData["duration"].toString ().getDoubleValue ()}};
    }
    else
    {
        Note baseNote = Note{currentChord.getRootNote()}.getTransposed((int)noteData["octave"] * 12);

        Note relativeNote = currentChord.findNotes (
            baseNote,
            Chord::getFindDirectionFromString (noteData["direction"].toString ()),
            (int) noteData["note"] + 1)[(int) noteData["note"]];

        // transpose by offset in scale
        int offset = (int) noteData["offset"];
        if (offset > 0)
        {
            relativeNote = currentChord.findScaleNotes(relativeNote.getTransposed(offset), Chord::FindDirection::up, 1, isScalePentatonic)[0];
        }
        else if (offset < 0)
        {
            relativeNote = currentChord.findScaleNotes(relativeNote.getTransposed(offset), Chord::FindDirection::down, 1, isScalePentatonic)[0];
        }
        // if offset == 0, do nothing

        return j::Array<TimeNote>{
            TimeNote{relativeNote, 0, noteData["duration"].toString ().getDoubleValue ()}
        };
    }
}

inline j::Array<TimeNote> getStrumNotes (j::var &noteData, Chord &currentChord, int octaveAdjustment = 0)
{
    std::vector<int> chordNotes = GuitarChord{currentChord}.getLowestPosition ();
    std::vector<int> strings = varIntArrayToVector (*noteData["strings"].getArray ());

    // if strings = [-1,-1,-1,-1], it becomes [5, 4, 3, 2]
    // basically, mimicking upward strum.
    if (std::all_of (strings.cbegin (), strings.cend (), [] (int i)
    {
        return i == -1;
    }))
    {
        // keep the original entry count (e.g. [-1,-1,-1,-1] -> [5,4,3,2]);
        // clearing first left size()==0 so the fallback produced no notes.
        for (int i = 0; i < (int) strings.size (); i++)
        {
            strings[i] = (int) chordNotes.size () - 1 - i;
        }
    }

    j::Array<TimeNote> ret{};
    auto offsets = noteData["offset"].getArray ();
    auto durations = noteData["durations"].getArray ();
    auto velocities = noteData["velocities"].getArray ();
    // durations/velocities are indexed with i % size() below; guard against
    // missing/empty arrays (null deref / divide-by-zero).
    if (durations == nullptr || durations->isEmpty () || velocities == nullptr || velocities->isEmpty ())
        return ret;
    for (int i = 0; i < strings.size (); i++)
    {
        double offset = 0;
        if (offsets != nullptr)
        {
            offset = (*offsets)[i % offsets->size ()];
        }


        if (chordNotes.size() != 0 && strings[i] >= 0)
        {
            //PRT this has been commented out as the guitar strummer has actually not been implemented yet
            // Apply the per-instrument octave correction, matching the legacy
            // HelperClass strum handler (noteIndex += octaveAdjustment * 12)
            // and the other pitched note paths. Fret noises (getFretNoises)
            // stay un-transposed — they are index-based sample selections, as
            // in legacy (Tools.notes[77 + sound], no octave adjustment).
            ret.add(TimeNote{ Note{chordNotes[strings[i] % chordNotes.size()]}.getTransposed (octaveAdjustment * 12),
                offset,
                (*durations)[i % durations->size()],
                (*velocities)[i % velocities->size()]
                });
        }
    }
    return ret;
}

inline j::Array<TimeNote> getFretNoises (j::var &noteData, Chord &currentChord)
{
    j::Array<TimeNote> ret{};
    auto sounds = noteData["sounds"].getArray ();
    auto offsets = noteData["offset"].getArray ();
    auto durations = noteData["durations"].getArray ();
    auto velocities = noteData["velocities"].getArray ();
    // sounds drives the loop; durations/velocities are indexed with i % size()
    // below. Guard against missing/empty arrays (null deref / divide-by-zero).
    if (sounds == nullptr || sounds->isEmpty () || durations == nullptr || durations->isEmpty () || velocities == nullptr || velocities->isEmpty ())
        return ret;

    for (int i = 0; i < sounds->size (); i++)
    {
        double offset = 0;
        if (offsets != nullptr)
        {
            offset = (*offsets)[i % offsets->size ()];
        }

        ret.add (TimeNote{
            Note{(int) (*sounds)[i]},
            offset,
            (*durations)[i % durations->size ()],
            (*velocities)[i % velocities->size ()],
            TimeNote::Type::fretNoise
        });
    }

    return ret;
}

inline j::Array<TimeNote> getRealNotes (j::var &noteData, Chord &currentChord, Chord &songKey, int octaveAdjustment = 0, bool canUseScaleNotes = false, bool isScalePentatonic = false)
{
    const j::String noteType = noteData["type"].toString ();
    if (noteType == "note")
        return getSimpleNote (noteData, currentChord, octaveAdjustment);

    if (noteType == "noteAbsolute")
    {
        Chord c = Chord{"C"};
        return getSimpleNote (noteData, c, octaveAdjustment);
    }

    if (noteType == "chord")
        return getChordNotes (noteData, currentChord, songKey, octaveAdjustment);

    if (noteType == "arpeggio")
        return getArpeggioNotes (noteData, currentChord, octaveAdjustment);

    if (noteType == "noteRelative")
        return getRelativeNote (noteData, currentChord, octaveAdjustment, canUseScaleNotes, isScalePentatonic);

    if (noteType == "strum")
        return getStrumNotes (noteData, currentChord, octaveAdjustment);

    if (noteType == "fretNoise")
        return getFretNoises (noteData, currentChord);

//    jassertfalse; // invalid note type
    DBG ("note type not implemented: " << noteType);
    return j::Array<TimeNote>{};
}

inline Chord getChordAtTime (j::Array<j::var> *segmentBars, int barIndex, double time)
{
    while (time >= 4.0)
    {
        time -= 4.0;
        barIndex++;
    }
    if (barIndex >= segmentBars->size ())
        return Chord{Note{"C"}, Chord::ChordType::invalidChord};
    j::String chordStr = (*segmentBars)[barIndex]["chords"][(int) trunc (time)];
    return Chord{chordStr};
}

inline j::Array<TimeNote>
getEDMArpeggiatorNotes (j::var &noteData, int barIndex, j::Array<j::var> *segmentBars, int octaveAdjustment)
{
    struct Metadata {
        j::Array<double> timePattern;
        int increment;
        j::Array<double> cycleMidPointBeat;
        Note lowestNote;
        Note highestNote;
        Note middleNote;
    };

    auto getMetadata = [octaveAdjustment] (j::var &noteData) -> Metadata
    {
        Metadata ret{};
        j::String rhythm = noteData["arpeggioRhythm"].toString ();
        int numberOfOctaves = (int) noteData["numberOfOctaves"];

        switch (numberOfOctaves)
        {
            case 2:
                ret.lowestNote = Note{"C4"}.getTransposed (-1);
                ret.highestNote = Note{"C6"};
                ret.middleNote = Note{"F#5"};
                break;
            case 3:
                ret.lowestNote = Note{"C3"}.getTransposed (-1);
                ret.highestNote = Note{"C6"};
                ret.middleNote = Note{"F#4"};
                break;
            case 4:
                ret.lowestNote = Note{"C3"}.getTransposed (-1);
                ret.highestNote = Note{"C7"};
                ret.middleNote = Note{"F#5"};
                break;
            default:
                throw std::invalid_argument ("Invalid number of octaves");
        }

        if (rhythm == "quarterNotes")
        {
            ret.timePattern = {0, 1, 2, 3, 4, 5, 6, 7};
            switch (numberOfOctaves)
            {
                case 2:
                    ret.increment = 1;
                    ret.cycleMidPointBeat = {4};
                    break;
                case 3:
                    ret.increment = 2;
                    ret.cycleMidPointBeat = {4};
                    break;
                case 4:
                    ret.increment = 3;
                    ret.cycleMidPointBeat = {4};
                    break;
                default:
                    throw std::invalid_argument ("Invalid number of octaves");
            }
        }
        else if (rhythm == "eighthNotes")
        {
            ret.timePattern = {0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5};
            switch (numberOfOctaves)
            {
                case 2:
                    ret.increment = 1;
                    ret.cycleMidPointBeat = {4};
                    break;
                case 3:
                case 4:
                    ret.increment = 2;
                    ret.cycleMidPointBeat = {2, 4, 6};
                    break;
                default:
                    throw std::invalid_argument ("Invalid number of octaves");
            }
        }
        else if (rhythm == "sixteenthNotes")
        {
            ret.timePattern = {0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4};
            ret.timePattern.addArray (j::Array<double>{4.25, 4.5, 4.75, 5, 5.25, 5.5, 5.75, 6, 6.25, 6.5, 6.75, 7, 7.25, 7.5, 7.75});

            switch (numberOfOctaves)
            {
                case 2:
                case 3:
                    ret.increment = 1;
                    ret.cycleMidPointBeat = {2, 4, 6};
                    break;
                case 4:
                    ret.increment = 1;
                    ret.cycleMidPointBeat = {4};
                    break;
                default:
                    throw std::invalid_argument ("Invalid number of octaves");
            }
        }
        else if (rhythm == "quarterNotes332")
        {
            ret.timePattern = {0, 1.5, 3, 4, 5.5, 7};
            switch (numberOfOctaves)
            {
                case 2:
                case 3:
                    ret.increment = 2;
                    ret.cycleMidPointBeat = {4};
                    break;
                case 4:
                    ret.increment = 3;
                    ret.cycleMidPointBeat = {4};
                    break;
                default:
                    throw std::invalid_argument ("Invalid number of octaves");
            }
        }
        else if (rhythm == "eighthNotes332")
        {
            ret.timePattern = {0, 0.75, 1.5, 2, 2.75, 3.5, 4, 4.75, 5.5, 6, 6.75, 7.5};
            switch (numberOfOctaves)
            {
                case 2:
                    ret.increment = 1;
                    ret.cycleMidPointBeat = {4};
                    break;
                case 3:
                case 4:
                    ret.increment = 2;
                    ret.cycleMidPointBeat = {4};
                    break;
                default:
                    throw std::invalid_argument ("Invalid number of octaves");
            }
        }
        else
        {
            throw std::invalid_argument ("Invalid rhythm");
        }

        ret.highestNote = ret.highestNote.getTransposed (octaveAdjustment * 12);
        ret.lowestNote = ret.lowestNote.getTransposed (octaveAdjustment * 12);
        ret.middleNote = ret.middleNote.getTransposed (octaveAdjustment * 12);

        return ret;
    };

    j::Array<TimeNote> ret{};

    Metadata metadata = getMetadata (noteData);

    Note lastLowestNote = metadata.lowestNote;
    Note lastHighestNote = metadata.highestNote;
    Chord::FindDirection currentDirection =
        noteData["arpeggioType"].toString () == "downAndUp" ? Chord::FindDirection::down : Chord::FindDirection::up;

    for (int i = 0; i < metadata.timePattern.size (); i++)
    {
        double time = metadata.timePattern[i];
        Chord currentChord = getChordAtTime (segmentBars, barIndex, time);
        Note nextNote;

        // If the chord is invalid, it's because the segment is over
        if (currentChord.getType () == Chord::ChordType::invalidChord)
            break;

        double noteDuration = std::min (
            ((i < metadata.timePattern.size () - 1) ? metadata.timePattern[i + 1] : 8 ) - time,
            noteData["noteDuration"].toString ().getDoubleValue ());
        if (noteData["arpeggioType"].toString () == "up")
        {
            if (time == 0 || metadata.cycleMidPointBeat.contains (time))
                lastLowestNote = metadata.lowestNote;

            nextNote = currentChord.findNextNote (lastLowestNote, Chord::FindDirection::up, metadata.increment);
            lastLowestNote = nextNote;
        }
        else if (noteData["arpeggioType"].toString () == "down")
        {
            if (time == 0 || metadata.cycleMidPointBeat.contains (time))
                lastHighestNote = metadata.highestNote;

            nextNote = currentChord.findNextNote (lastHighestNote, Chord::FindDirection::down, metadata.increment);
            lastHighestNote = nextNote;
        }
        else if (noteData["arpeggioType"].toString () == "downAndUp" || noteData["arpeggioType"].toString () == "upAndDown")
        {
            if (metadata.cycleMidPointBeat.contains (time))
            {
                currentDirection = currentDirection == Chord::FindDirection::up ? Chord::FindDirection::down: Chord::FindDirection::up;
                lastHighestNote = metadata.highestNote;
                lastLowestNote = metadata.lowestNote;
            }
            if (currentDirection == Chord::FindDirection::up)
            {
                nextNote = currentChord.findNextNote (lastLowestNote, Chord::FindDirection::up, metadata.increment);
                lastLowestNote = nextNote;
            }
            else // if currentDirection == down
            {
                nextNote = currentChord.findNextNote (lastHighestNote, Chord::FindDirection::down, metadata.increment);
                lastHighestNote = nextNote;
            }
        }
        else if (noteData["arpeggioType"].toString () == "insideOut")
        {
            if (time == 0 || metadata.cycleMidPointBeat.contains (time))
            {
                lastLowestNote = metadata.middleNote;
                lastHighestNote = metadata.middleNote;
            }
            if (currentDirection == Chord::FindDirection::up)
            {
                nextNote = currentChord.findNextNote (lastHighestNote, Chord::FindDirection::down, metadata.increment);

                lastHighestNote = nextNote;
                currentDirection = Chord::FindDirection::down;
            }
            else // if currentDirection == down
            {
                nextNote = currentChord.findNextNote (lastLowestNote, Chord::FindDirection::up, metadata.increment);

                lastLowestNote = nextNote;
                currentDirection = Chord::FindDirection::up;
            }
        }
        else if (noteData["arpeggioType"].toString () == "outsideIn")
        {
            if (metadata.cycleMidPointBeat.contains (time))
            {
                lastLowestNote = metadata.lowestNote;
                lastHighestNote = metadata.highestNote;
            }
            if (currentDirection == Chord::FindDirection::up)
            {
                nextNote = currentChord.findNextNote (lastLowestNote, Chord::FindDirection::up, metadata.increment);

                lastLowestNote = nextNote;
                currentDirection = Chord::FindDirection::down;
            }
            else // if currentDirection == down
            {
                nextNote = currentChord.findNextNote (lastHighestNote, Chord::FindDirection::down, metadata.increment);

                lastHighestNote = nextNote;
                currentDirection = Chord::FindDirection::up;
            }

        }
        else
        {
            throw std::invalid_argument ("Invalid arpeggio type");
        }
        ret.add ({nextNote, (barIndex * 4) + time, noteDuration});
    }

    return ret;
}

inline j::Array<TimeStrums>
getGuitarStrums (j::var &noteData, Chord currentChord)
{
    j::Array<TimeStrums> ret{};

    TimeStrums timeStrums{};

    j::String event = noteData["event"].toString ();
    timeStrums.setTypeFromString (event);

    if(timeStrums.type == TimeStrums::Type::fx)
    {
        timeStrums.fxName = event;
    }
    else
    {
        timeStrums.chord = currentChord;
        timeStrums.chordPosition =
            noteData.hasProperty ("chordPosition") && noteData["chordPosition"].isString ()
            ? noteData["chordPosition"].toString ().getIntValue ()
            : 1;
    }

    // docs/54m: accept int or double — original isDouble() filtered out
    // integer-valued JSON numbers, leaving the default -1 + strum-tail
    // offset → negative duration → Tracktion silently dropped the note.
    if (noteData.hasProperty ("duration")) {
        timeStrums.duration = noteData["duration"].toString ().getDoubleValue ();
    }

    ret.add (timeStrums);

    return ret;
}

inline void addNoteToClip(te::MidiClip *clip, const TimeNote &timeNote, VelocityMode velocityMode = none)
{
    std::vector<float> normalisedVelocities {0.9, 0.7, 0.5, 0.3};
    std::vector<float> oldNormalisedVelocities {0.8, 0.7, 0.6, 0.5};
    
    int velocity = timeNote.velocity;

    if (velocityMode == VelocityMode::beat) {
        if (std::fmod(timeNote.start, 4.0) == 0.0)
            velocity = static_cast<int>(normalisedVelocities[0] * 127);
        else if (std::fmod(timeNote.start, 2.0) == 0.0)
            velocity = static_cast<int>(normalisedVelocities[1] * 127);
        else if (std::fmod(timeNote.start, 1.0) == 0.0)
            velocity = static_cast<int>(normalisedVelocities[2] * 127);
        else
            velocity = static_cast<int>(normalisedVelocities[3] * 127);
    } else if (velocityMode == VelocityMode::randomised) {
        velocity += (randomNumberGenerator.nextInt (127) - 65) / 5;
    }

    auto sequence = &clip->getSequence();

    // check previous notes to see if there is an overlapping note
    for (int i = sequence->getNumNotes(); --i >= 0;)
    {
        auto note = sequence->getNote (i);
        if (note->getNoteNumber () == timeNote.note.midiNote && note->getStartBeat().inBeats () < timeNote.start && note->getEndBeat().inBeats () > timeNote.start)
        {
            // if there is, shorten the previous note
            note->setStartAndLength (note->getStartBeat(), te::BeatDuration::fromBeats (timeNote.start - note->getStartBeat().inBeats ()), nullptr);
        }
    }

    sequence->addNote (timeNote.note.midiNote, te::BeatPosition::fromBeats (timeNote.start), te::BeatDuration::fromBeats(timeNote.duration), velocity, 1, nullptr);
}

/* track utils */
inline void clearTrack (tracktion_engine::ClipTrack *track)
{
    std::cout << "cleaning up track " << track->getName () << std::endl;
    auto &clips = track->getClips ();
    for (int i = clips.size (); --i >= 0;)

    #if JUCE_ANDROID || JUCE_EMSCRIPTEN
        clips[i]->removeFromParentTrack (); // Android and emscripten use older tracktion engine version
    #else
        clips[i]->removeFromParent ();
    #endif
}

inline void applyMuteToTrack (te::AudioTrack *track, const te::TimeRange &segTimeRange, const j::var &mute)
{
    if (!(bool) mute) return;

    j::String muteType = mute["type"].toString ();

    std::regex re{"([0-9]+)To([0-9]+)"};
    std::smatch match;
    std::string muteTypeStr = muteType.toStdString ();
    if (std::regex_search (muteTypeStr, match, re) && match.size () == 3)
    {
        float muteStart = j::String{match.str (1)}.getFloatValue () / 100.0;  // e.g. 25 -> 0.25
        float muteEnd = j::String{match.str (2)}.getFloatValue () / 100.0;    // e.g. 75 -> 0.75

        te::AutomatableParameter::Ptr volParam = track->getVolumePlugin ()->getAutomatableParameterByID ("volume");
        te::AutomationCurve curve = volParam->getCurve ();
        float defaultValue = curve.getValueAt (segTimeRange.getStart ());
        te::TimePosition startMuteTime = segTimeRange.getStart () + (segTimeRange.getLength () * muteStart);
        te::TimePosition endMuteTime = segTimeRange.getStart () + (segTimeRange.getLength () * muteEnd);
        curve.addPoint (startMuteTime, defaultValue, 0);
        curve.addPoint (startMuteTime, 0, 0);
        curve.addPoint (endMuteTime, 0, 0);
        curve.addPoint (endMuteTime, defaultValue, 0);
    }
}

inline void applyPostVolumeToTrack (te::Edit &edit, te::AudioTrack *track, float db)
{
    te::VolumeAndPanPlugin *postVolPlugin{};

    te::Plugin::Array trackPlugins = track->pluginList.getPlugins ();
    te::Plugin::Ptr lastPlugin = trackPlugins[trackPlugins.size () - 1];

    if (lastPlugin->getPluginType () == "volume")
    {
        postVolPlugin = dynamic_cast<te::VolumeAndPanPlugin *>(lastPlugin.get ());
        if (db == 0)
        {
            // if there is a vol plugin and db is 0, remove plugin and leave
            postVolPlugin->deleteFromParent ();
            return;
        }
    }
    else
    {
        if (db == 0) return; // if there is no plugin and db is 0, do nothing

        postVolPlugin = dynamic_cast<te::VolumeAndPanPlugin *> (edit.getPluginCache ().createNewPlugin (te::VolumeAndPanPlugin::xmlTypeName, {}).get ());

        //We are adding the volume and pan plugin prior to the
        track->pluginList.insertPlugin (*postVolPlugin, trackPlugins.size() - 3, nullptr);
    }

    jassert (postVolPlugin);
    postVolPlugin->setVolumeDb (db);
}

inline void applyPreVolumeToTrack (te::Edit &edit, te::AudioTrack *track, float db)
{
    te::VolumeAndPanPlugin *preVolPlugin{};

    te::Plugin::Array trackPlugins = track->pluginList.getPlugins ();
    te::Plugin::Ptr lastPlugin = trackPlugins[trackPlugins.size () - 1];
    
    int lowPassPluginIndex = 0;
    for (auto trackPlugin : trackPlugins)
    {
        //First check if there is a low pass in the chain
        if (auto lowPassPlugin = dynamic_cast<te::LowPassPlugin*> (trackPlugin))
        {
            preVolPlugin = dynamic_cast<te::VolumeAndPanPlugin *> (edit.getPluginCache ().createNewPlugin (te::VolumeAndPanPlugin::xmlTypeName, {}).get ());
            track->pluginList.insertPlugin (*preVolPlugin, lowPassPluginIndex + 1, nullptr);
            jassert (preVolPlugin);
            preVolPlugin->setVolumeDb (db);
            return;
        }
        lowPassPluginIndex++;
    }
    int samplerPluginIndex = 0;
    for (auto trackPlugin : trackPlugins)
    {
        if (auto samplerPlugin = dynamic_cast<te::SamplerPlugin*> (trackPlugin))
        {
            preVolPlugin = dynamic_cast<te::VolumeAndPanPlugin *> (edit.getPluginCache ().createNewPlugin (te::VolumeAndPanPlugin::xmlTypeName, {}).get ());
            track->pluginList.insertPlugin (*preVolPlugin, samplerPluginIndex + 1, nullptr);
            jassert (preVolPlugin);
            preVolPlugin->setVolumeDb (db);
            return;
        }
        else if (auto samplerPlugin = dynamic_cast<tracktion::CasperakiSamplerPlugin*> (trackPlugin))
        {
            preVolPlugin = dynamic_cast<te::VolumeAndPanPlugin *> (edit.getPluginCache ().createNewPlugin (te::VolumeAndPanPlugin::xmlTypeName, {}).get ());
            track->pluginList.insertPlugin (*preVolPlugin, samplerPluginIndex + 1, nullptr);
            jassert (preVolPlugin);
            preVolPlugin->setVolumeDb (db);
            return;
        }
        samplerPluginIndex++;
    }

    preVolPlugin = dynamic_cast<te::VolumeAndPanPlugin*> (edit.getPluginCache().createNewPlugin (te::VolumeAndPanPlugin::xmlTypeName, {}).get());
    track->pluginList.insertPlugin(*preVolPlugin, 0, nullptr);
    jassert(preVolPlugin);
    preVolPlugin->setVolumeDb(db);
    return;
}
