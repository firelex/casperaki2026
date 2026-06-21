//
// Created by Tiago Alves on 13/06/2022.
//

#pragma once

#include <JuceHeader.h>
#include <regex>

#include "Note.h"
#include "ChordData.h"

struct Chord {
 public:
  // ChordType ==================================================
  enum ChordType {
      invalidChord = -1,
      major = 0,
      minor,
      Mdim,
      Mdim7,
      Msus2,
      Msus4,
      M7sus4,
      M5,
      Malt,
      Maug,
      M6,
      M69,
      M7,
      M7b5,
      Maug7,
      M9,
      M9b5,
      Maug9,
      M7b9,
      M7s9,
      M11,
      M9s11,
      M13,
      Mmaj7,
      Mmaj7b5,
      Mmaj7s5,
      Mmaj9,
      Mmaj11,
      Mmaj13,
      m6,
      m7,
      m7b5,
      m9,
      m69,
      m11,
      mmaj7,
      mmaj7b5,
      mmaj9,
      mmaj11,
      Madd9,
      madd9
  };

  //A chord with an empty string ID will default to major
  static inline std::unordered_map<j::String, ChordType> const typeTable = {
      {"major", major},
      {"", major},
      {"minor", minor},
      {"m", minor},
      {"dim", Mdim},
      {"dim7", Mdim7},
      {"sus2", Msus2},
      {"sus4", Msus4},
      {"sus", Msus4},
      {"7sus4", M7sus4},
      {"5", M5},
      {"alt", Malt},
      {"aug", Maug},
      {"6", M6},
      {"69", M69},
      {"7", M7},
      {"7b5", M7b5},
      {"aug7", Maug7},
      {"9", M9},
      {"9b5", M9b5},
      {"aug9", Maug9},
      {"7b9", M7b9},
      {"7#9", M7s9},
      {"11", M11},
      {"9#11", M9s11},
      {"13", M13},
      {"maj7", Mmaj7},
      {"maj7b5", Mmaj7b5},
      {"maj7#5", Mmaj7s5},
      {"maj9", Mmaj9},
      {"maj11", Mmaj11},
      {"maj13", Mmaj13},
      {"m6", m6},
      {"m7", m7},
      {"m7b5", m7b5},
      {"m9", m9},
      {"m69", m69},
      {"m11", m11},
      {"mmaj7", mmaj7},
      {"mmaj7b5", mmaj7b5},
      {"mmaj9", mmaj9},
      {"mmaj11", mmaj11},
      {"add9", Madd9},
      {"madd9", madd9}
  };
  static ChordType getTypeFromString (j::String typeStr)
  {
      std::unordered_map<j::String, ChordType>::const_iterator itg = typeTable.find (typeStr);
      if (itg == typeTable.end ())
      {
          DBG("Could not find chord type: " << typeStr);
          jassertfalse;
      }

      return itg.operator-> ()->second;
  }

  static j::String chordTypeToString (ChordType type, bool shortFormat = false)
  {
      if (type == major) return shortFormat ? "" : "major";
      if (type == minor) return shortFormat ? "m" : "minor";
      for (auto it = typeTable.begin (); it != typeTable.end (); it++)
      {
          if (it.operator-> ()->second == type)
          {
              return it.operator-> ()->first;
          }
      }
      jassertfalse;
  }

  // Cord ==================================================
  Chord (Note _rootNote, ChordType _type) : rootNote (_rootNote.getRootNote ()), type (_type)
  {}

  Chord (j::String chordName)
  {
      std::regex re{"([A-Ga-g][#b]{0,1})([A-Za-z0-9#]*)"};
      std::smatch match;
      std::string chordNameStr = chordName.toStdString ();
      if (std::regex_search (chordNameStr, match, re) && match.size () == 3)
      {
          rootNote = Note{match.str (1)};
          type = getTypeFromString (match.str (2));
      }
      else
      {
          type = invalidChord;
      }
  }

  Note &getRootNote ()
  {return rootNote;}
  ChordType &getType ()
  {return type;}

  j::String toString (bool shortFormat = false)
  {
      return rootNote.toString (false) + chordTypeToString (type, shortFormat);
  }

  enum FindDirection {
      up,
      down,
      center
  };

  static FindDirection getFindDirectionFromString (j::String str)
  {
      if (str == "up") return up;
      if (str == "down") return down;
      if (str == "center") return center;
      jassertfalse; // invalid direction
  }

  j::Array<Note> findNotes (Note baseNote, FindDirection direction, int numberOfNotes)
  {
      j::Array<Note> notes{};

      int noteOffset = 0;
      while (notes.size () < numberOfNotes)
      {
          Note thisNote = baseNote.getTransposed (noteOffset);

          if (isNoteInChord (thisNote))
          {
              notes.add (thisNote);
          }

          switch (direction)
          {
              case center:
                  // if direction center, find notes around the base note;
                  noteOffset = noteOffset * -1;
                  if (noteOffset <= 0)
                      noteOffset--;
                  break;
              case up:
                  noteOffset++;
                  break;
              case down:
                  noteOffset--;
                  break;
          }
      }

      // if direction center, sort note list
      if (direction == center)
          notes.sort ();

      return notes;
  }

  j::Array<Note> findScaleNotes (Note baseNote, FindDirection direction, int numberOfNotes, bool isScalePentatonic = false)
  {
      j::Array<Note> notes{};

      int noteOffset = 0;
      while (notes.size () < numberOfNotes)
      {
          Note thisNote = baseNote.getTransposed (noteOffset);

          if (isNoteInScale (thisNote, isScalePentatonic))
          {
              notes.add (thisNote);
          }

          switch (direction)
          {
              case center:
                  // if direction center, find notes around the base note;
                  noteOffset = noteOffset * -1;
                  if (noteOffset >= 0)
                      noteOffset++;
                  break;
              case up:
                  noteOffset++;
                  break;
              case down:
                  noteOffset--;
                  break;
          }
      }

      // if direction center, sort note list
      if (direction == center)
          notes.sort ();

      return notes;
  }

  Note findNextNote (Note baseNote, FindDirection direction, int increment = 1)
  {
      return findNotes (baseNote.getTransposed ( direction == up ? 1 : -1), direction, increment)[increment - 1];
  }

  bool isNoteInChord (Note note)
  {
      if (type == invalidChord) throw std::invalid_argument ("Invalid chord type");

      Note noteRootNote = note.getRootNote ();
      j::Array<int> steps = getChordSteps ();
      for (int i = 0; i < steps.size (); i++)
      {
          if (rootNote.getTransposed (steps[i]).isSameRoot (noteRootNote))
          {
              return true;
          }
      }

      return false;
  }

  bool isNoteInScale (Note note, bool isScalePentatonic = false)
  {
      if (type == invalidChord) throw std::invalid_argument ("Invalid chord type");

      Note noteRootNote = note.getRootNote ();
      j::Array<int> steps = getScaleSteps ();
      if (isScalePentatonic)
      {
          steps.removeAllInstancesOf(5);
          steps.removeAllInstancesOf(11);
      }
      for (int i = 0; i < steps.size (); i++)
      {
          if (rootNote.getTransposed (steps[i]).isSameRoot (noteRootNote))
          {
              return true;
          }
      }

      return false;
  }

  bool operator== (const Chord &other) const noexcept
  {
      return rootNote == other.rootNote && type == other.type;
  }

 private:
  Note rootNote{0};
  ChordType type = major;

  j::Array<int> getChordSteps ()
  {
      switch (type)
      {
          case major:
              return {0, 4, 7};
          case minor:
              return {0, 3, 7};
          case Mdim:
              return {0, 3, 6};
          case Mdim7:
              return {0, 3, 6, 9};
          case Msus2:
              return {0, 2, 7};
          case Msus4:
              return {0, 5, 7};
          case M7sus4:
              return {0, 5, 7, 10};
          case M5:
              return {0, 7};
          case Malt:
              return {0, 4, 6};
          case Maug:
              return {0, 4, 8};
          case M6:
              return {0, 4, 7, 9};
          case M69:
              return {0, 2, 4, 7, 9};
          case M7:
              return {0, 4, 7, 10};
          case M7b5:
              return {0, 4, 6, 10};
          case Maug7:
              return {0, 4, 8, 10};
          case M9:
              return {0, 2, 4, 7, 10};
          case M9b5:
              return {0, 2, 4, 6, 10};
          case Maug9:
              return {0, 2, 4, 8, 10};
          case M7b9:
              return {0, 1, 4, 7, 10};
          case M7s9:
              return {0, 3, 4, 7, 10};
          case M11:
              return {0, 4, 5, 10};
          case M9s11:
              return {0, 2, 4, 6, 10};
          case M13:
              return {0, 4, 5, 7, 9, 10};
          case Mmaj7:
              return {0, 4, 7, 11};
          case Mmaj7b5:
              return {0, 4, 6, 11};
          case Mmaj7s5:
              return {0, 4, 8, 11};
          case Mmaj9:
              return {0, 2, 4, 7, 11};
          case Mmaj11:
              return {0, 4, 5, 7, 11};
          case Mmaj13:
              return {0, 4, 5, 9, 11};
          case m6:
              return {0, 3, 7, 9};
          case m7:
              return {0, 3, 7, 10};
          case m7b5:
              return {0, 3, 6, 10};
          case m9:
              return {0, 2, 3, 7, 10};
          case m69:
              return {0, 2, 3, 7, 9};
          case m11:
              return {0, 2, 3, 5, 10};
          case mmaj7:
              return {0, 3, 7, 11};
          case mmaj7b5:
              return {0, 3, 6, 11};
          case mmaj9:
              return {0, 2, 3, 11};
          case mmaj11:
              return {0, 3, 5, 7, 11};
          case Madd9:
              return {0, 2, 4, 7};
          case madd9:
              return {0, 2, 3, 7};
          case invalidChord:
          default:
              return {};
      }
  }

  j::Array<int> getScaleSteps ()
  {
      switch (type)
      {
          case major:
          case Mdim:
          case Msus2:
          case Msus4:
          case M5:
          case M6:
          case M69:
          case Mmaj7:
          case Mmaj9:
          case Mmaj11:
          case Mmaj13:
          case Madd9:
              return {0, 2, 4, 5, 7, 9, 11};
          case M7:
          case M9:
          case M11:
          case M13:
          case M7sus4:
              return {0, 2, 4, 5, 7, 9, 10};

          case M9s11:
          case Malt:
          case M9b5:
          case M7b5:
              return {0, 2, 4, 6, 7, 9, 10};
          case Maug:
          case Maug7:
          case Maug9:
              return {0, 2, 4, 5, 7, 8, 10};

          case Mmaj7b5:
          case Mmaj7s5:
              return {0, 2, 4, 6, 8, 9, 11};

          case Mdim7:
              return {0, 2, 3, 5, 6, 9, 11};

          case M7s9:
          case M7b9:
              return {0, 1, 3, 4, 7, 9, 10};

          case minor:
          case m6:
          case m69:
          case mmaj9:
          case mmaj11:
          case madd9:
          case mmaj7:
              return {0, 2, 3, 5, 7, 9, 11};

          case mmaj7b5:
              return {0, 2, 3, 5, 6, 8, 11};

          case m7b5:
              return {0, 2, 3, 5, 6, 8, 10};

          case m7:
          case m9:
          case m11:
              return {0, 2, 3, 5, 7, 9, 10};

          case invalidChord:
          default:
              return {};
      }
  }
};

//loadGuitarChordData();
//const static j::var guitarChordJSON = j::JSON::parse (BinaryData::ChordData_json);

inline std::vector<int> varIntArrayToVector (j::Array<j::var> varArray)
{
    std::vector<int> ret{};
    for (auto val: varArray)
    {
        ret.push_back ((int) val);
    }
    return ret;
}

struct GuitarChord {
 public:
  struct Position {
      std::vector<int> frets;
      std::vector<int> fingers;
      int baseFret;
      std::vector<int> barres;
      std::vector<int> midi;
  };

  GuitarChord (Chord _chord) : chord (_chord)
  {
      const j::String chordRootStr = chord.getRootNote ().toString (false);
      j::String chordSuffixStr = Chord::chordTypeToString (chord.getType ());
      if (chordSuffixStr == "sus")
      {
          chordSuffixStr = "sus4";
      }
      const j::var guitarChordJSON = j::JSON::parse (BinaryData::ChordData_json);

      jassert(chordRootStr.isNotEmpty ());

      jassert(guitarChordJSON[chordRootStr.toRawUTF8 ()].isArray ());
      j::Array<j::var> *chordVariants = guitarChordJSON[chordRootStr.toRawUTF8 ()].getArray ();

      bool foundVariant = false;
      for (const auto variantData: *chordVariants)
      {
          if (variantData["suffix"].toString () == chordSuffixStr)
          {
              foundVariant = true;
              for (auto position: *variantData["positions"].getArray ())
              {
                  positions.add ({
                                     varIntArrayToVector (*position["frets"].getArray ()),     // frets
                                     varIntArrayToVector (*position["fingers"].getArray ()),   // fingers
                                     position["baseFret"],                                   // baseFret
                                     varIntArrayToVector (*position["barres"].getArray ()),    // barres
                                     varIntArrayToVector (*position["midi"].getArray ()),      // midi
                                 });
              }
              break;
          }
      }
      if (!foundVariant)
      {
          DBG("Could not find variant for: " << chord.toString () << " -> " << chordSuffixStr);
      }
      //      jassert(foundVariant); // found variant
  }

  std::vector<int> getLowestPosition ()
  {
      int lowestPos = 0;

      // This code was commented because the legacy app is always picking the first position now
//      int lowestNote = 1000;
//      for (int i = 0; i < positions.size (); i++)
//      {
//          for (auto m: positions[i].midi)
//          {
//              if (m < lowestNote)
//              {
//                  lowestNote = m;
//                  lowestPos = i;
//              }
//          }
//      }

      return positions[lowestPos].midi;
  }

  Chord chord{"C"};
  j::Array<Position> positions;

};

