//
// Created by Tiago Alves on 17/06/2022.
//

#pragma once

#include "Instrument.h"

#include "../config.h"

#if defined (USE_TE_SAMPLER)
    using SamplerPlugin = te::SamplerPlugin;
#elif defined (USE_CASPERAKI_SAMPLER)
    using SamplerPlugin = tracktion::CasperakiSamplerPlugin;
#endif

class TonalInstrument : public Instrument {
 public:
  TonalInstrument (te::Edit &edit, const j::var &instrumentData, juce::String baseURL)
      : Instrument (edit, instrumentData, baseURL)
  {
      auto detailsData = instrumentData["details"];

      if (detailsData.hasProperty ("GMProgramNumber")) GMProgramNumber = detailsData["GMProgramNumber"];
      if (detailsData.hasProperty ("LRA")) LRA = detailsData["LRA"];
      if (detailsData.hasProperty ("LUFS")) LUFS = detailsData["LUFS"];
      if (detailsData.hasProperty ("octaveAdjustment")) octaveAdjustment = detailsData["octaveAdjustment"];
      if (detailsData.hasProperty ("threshold")) threshold = detailsData["threshold"];
      if (detailsData.hasProperty ("vstPlugin")) vstPlugin = detailsData["vstPlugin"];
  }

  virtual void createSegmentClip (const j::String &segName, const te::TimeRange &segTimeRange,
                                  const te::TimeRange &loopTimeRange, const j::Array<TimeNote> &notes, const j::Array<TimeStrums> &timeStrums, const j::var &mute) = 0;

  void
  processSegment (j::var songData, Instrument *inst, j::String segmentName, te::TimeRange segmentTimeRange, j::Array<j::var> *segmentBars) override
  {
      // get pattern
      j::var pattern = getInstrumentPattern (songData, inst->id);
      if (pattern.isUndefined())
      {
          return;
      }

      // get instrument scale type
      bool isScalePentatonic = false;
      if (pattern.hasProperty ("scale"))
      {
          isScalePentatonic = pattern["scale"].toString () == "pentatonic";
      }

      auto tonalInstrument = dynamic_cast<TonalInstrument *> (inst);
      if (tonalInstrument == nullptr)
      {
          DBG("Instrument " << inst->id << " is not TonalInstrument!");
          return;
      }

      Chord songKey (songData["key"].toString ());
      const j::var override = getInstrumentOverride (songData, inst, segmentName);
      const j::var mute = getInstrumentMute (songData, inst, segmentName);

      // if override exists, use it instead
      if (override.isObject ())
      {
          pattern = override;
      }

      // { bars: [] }
      const j::Array<j::var> *bars = pattern["bars"].getArray ();
      te::TimeRange loopTimeRange = te::TimeRange{
          te::TimePosition{},
          edit.tempoSequence.toTime (te::BeatPosition::fromBeats (segmentBars->size () * 4))
      };

      j::Array<TimeNote> timeNotes{};
      j::Array<TimeStrums> timeStrums{};
      // for each bar
      int numBarsToProcess = segmentBars->size ();
      int patternBarIndex = 0;
      for (int barIndex = 0; barIndex < numBarsToProcess; barIndex++)
      {
          patternBarIndex = barIndex % bars->size ();
          if (!(*bars)[patternBarIndex].isObject ()) continue;

          auto notes = (*bars)[patternBarIndex]["notes"].getDynamicObject ()->getProperties ();
          // for each time position in bar (0.0, 2.0, 3.5...)
          for (auto it = notes.begin (); it != notes.end (); it++)
          {
              auto notesArray = it->value.getArray ();
              double noteTime = it->name.toString ().getDoubleValue ();

              // for each note in that time position
              for (int noteIndex = 0; noteIndex < notesArray->size (); noteIndex++)
              {
                  auto noteData = (*notesArray)[noteIndex];

                  if (noteData.isObject () && noteData["type"].toString () == "EDMArpeggiator") // for EDM arpeggiator notes
                  {
                      Array<TimeNote> realNotes = getEDMArpeggiatorNotes (noteData, barIndex, segmentBars, tonalInstrument->octaveAdjustment);
                      timeNotes.addArray (realNotes);
                  }
                  else if (noteData.isObject () && noteData["type"].toString () == "virtualGuitarist") // for virtual guitarist notes
                  {
                      Chord currentChord = getChordAtTime (segmentBars, barIndex, noteTime);

                      Array<TimeStrums> realNotes = getGuitarStrums (noteData, currentChord);
                      double bpm = edit.tempoSequence.getTempoAt (segmentTimeRange.getStart()).bpm;
                      bool isAcoustic = lowLevelType.startsWith("acoustic");
                      for (auto realNote: realNotes)
                      {

                          // adjust the start times for strums
                          double timeOffsetInSeconds;
                          if (realNote.type == TimeStrums::Type::longStrumUp || realNote.type == TimeStrums::Type::longStrumDown)
                              timeOffsetInSeconds = (isAcoustic ? -0.17 : -0.15) - ( bpm - 110 ) / 10 * 0.01;
                          else
                              timeOffsetInSeconds = (isAcoustic ? -0.03 : -0.01);

                          double durationOffsetInSeconds = 0.1 - std::min ( 0.0, ( bpm - 110 ) / 5 * 0.01 );

                          realNote.start += (barIndex * 4) + noteTime + (timeOffsetInSeconds / 60 * bpm); // add the bar/beat time to the note offset
                          realNote.duration += durationOffsetInSeconds / 60 * bpm;
                          timeStrums.add (realNote);
                      }
                  }
                  else if (
                          !noteData.hasProperty ("duration")
                          || noteData["type"].toString () == "noteAbsolute"
                          ) // add notes as they are. don't break them
                  {
                      Chord currentChord = getChordAtTime (segmentBars, barIndex, fmax(noteTime, 0.0));
//                      if (currentChord.getType () == Chord::ChordType::invalidChord) continue;
                      Array<TimeNote> realNotes = getRealNotes (noteData, currentChord, songKey, tonalInstrument->octaveAdjustment);
                      for (auto realNote: realNotes)
                      {
                          realNote.start += (barIndex * 4) + noteTime; // add the bar/beat time to the note offset
                          timeNotes.add (realNote);
                      }
                  }
                  else // break the notes if the chord changes
                  {
                      double noteStart = noteTime;
                      double noteDuration = noteData["duration"].toString ().getDoubleValue ();

                      while (noteDuration > 0)
                      {
                          double thisChordBreaksAt = noteStart;
                          // if note start is negative, we actually want the chord at the start of the bar
                          if (noteStart < 0)
                          {
                              thisChordBreaksAt = 0;
                          }
                          Chord thisChord = getChordAtTime (segmentBars, barIndex, thisChordBreaksAt);
                          if (thisChord.getType () == Chord::ChordType::invalidChord)
                          {
                              break;
                          }
                          thisChordBreaksAt = trunc (thisChordBreaksAt);
                          do
                          {
                              thisChordBreaksAt += 1;
                          }
                          while ((thisChordBreaksAt - noteStart) < noteDuration
                                 && thisChord == getChordAtTime (segmentBars, barIndex, thisChordBreaksAt));

                          var thisNoteData = noteData.clone ();
                          auto thisNoteDataObj = thisNoteData.getDynamicObject ();
                          double duration = fmin (thisChordBreaksAt - noteStart, thisNoteData["duration"].toString ().getDoubleValue ());

                          thisNoteDataObj->setProperty ("duration", duration);

                          // see https://github.com/firelex/casperaki-fe2/blob/7e287ffc005e996d5a3acbd6b7f84aab440d3eeb/views/js/modules/common/tools.js#L16881
                          bool canUseScaleNotes = std::fmod (noteStart, 1) != 0.0 // we're not on a beat
                              && (fmod(noteStart, 0.5) != 0.0 || duration >= 0.5) // we're not on a half beat
                              && notesArray->size () > 1 // there's more than one note in this time position
                              && noteIndex ==0; // this is the first note in this time position

                          Array<TimeNote> realNotes = getRealNotes (thisNoteData, thisChord, songKey, tonalInstrument->octaveAdjustment, canUseScaleNotes, isScalePentatonic);

                          for (auto realNote: realNotes)
                          {
                              realNote.start += (barIndex * 4) + noteStart; // add the bar/beat time to the note offset
                              timeNotes.add (realNote);
                          }

                          noteStart = thisChordBreaksAt;
                          noteDuration -= thisNoteData["duration"].toString ().getDoubleValue ();
                      }
                  }
              };
          }
      }

      // check if there are notes that start at negative time
      // (i.e., before the segment starts) and stretch the segment time range
      // to include them
      double stretchStart = 0; // this is the amount of time to add to the segment start in beats
      for (const auto& timeNote : timeNotes)
      {
          if (timeNote.start < -stretchStart)
          {
              stretchStart = -timeNote.start;
          }
      }
      for (const auto& timeStrum : timeStrums)
      {
          if (timeStrum.start < -stretchStart)
          {
              stretchStart = -timeStrum.start;
          }
      }

      te::TimeRange newSegTimeRange = segmentTimeRange;

      if (stretchStart != 0)
      {
          DBG ("Stretching segment " << segmentName << " for inst " << name << ": stretchStart: " << stretchStart);
          double newSegStart = segmentTimeRange.getStart().inSeconds() - edit.tempoSequence.toTime(te::BeatPosition::fromBeats(stretchStart)).inSeconds();
          double newLength = segmentTimeRange.getLength().inSeconds() + edit.tempoSequence.toTime(te::BeatPosition::fromBeats(stretchStart)).inSeconds();
          newSegTimeRange = te::TimeRange(
                  te::TimePosition::fromSeconds(newSegStart),
                  te::TimeDuration::fromSeconds(newLength));

          loopTimeRange = loopTimeRange.withLength(te::TimeDuration::fromSeconds(newLength));

          // also adjust the start time of all notes
          if (stretchStart != 0)
          {
              for (auto& timeNote : timeNotes)
              {
                  timeNote.start += stretchStart;
              }
              for (auto& timeStrum : timeStrums)
              {
                  timeStrum.start += stretchStart;
              }
          }
      }

      DBG ("Processed segment " << segmentName << " for inst " << name << ": segmentTimeRange: "
                                << newSegTimeRange.getStart () << "/" << newSegTimeRange.getLength ()
                                << ": loopTimeRange: " << loopTimeRange.getStart () << "/"
                                << loopTimeRange.getLength ());

      tonalInstrument->createSegmentClip (segmentName, newSegTimeRange, loopTimeRange, timeNotes, timeStrums, mute);
  }

  int getPatternBarsCount (j::var pattern) override
  {
      if (!pattern["bars"].isArray ()) return 0;
      return pattern["bars"].size ();
  }

  int GMProgramNumber = 0;
  float LRA = 0;
  float LUFS = 0;
  int octaveAdjustment = 0;
  float threshold = 0;
  float truePeak = 0;
  j::String vstPlugin{""};
};
