//
// Created by Tiago Alves on 22/06/2022.
//

#pragma once

#include "Instrument.h"
#include "SamplesDownloadTask.h"

class TransitionSample : public Instrument {
 public:
  TransitionSample (te::Edit &edit, const j::var &instrumentData, juce::String baseURL)
      : Instrument (edit, instrumentData, baseURL)
  {
      auto detailsData = instrumentData["details"];

      if (detailsData.hasProperty ("bpm")) bpm = detailsData["bpm"];
      else
          jassertfalse;

      if (detailsData.hasProperty ("duration")) duration = detailsData["duration"];
      else
          jassertfalse;

      if (detailsData.hasProperty ("climax")) climax = detailsData["climax"];
      else climax = 0;

      initSampleFile ();
  }

  virtual ~TransitionSample ()
  {

 //     juce::Logger::writeToLog ("TransitionSample DESTROYED!!!");
  }

  j::Array<te::AudioTrack *> getAudioTracks () override
  {
      return j::Array<te::AudioTrack *>{};
  }

  void
  processSegment (j::var songData, Instrument *inst, j::String segmentName, te::TimeRange segmentTimeRange, j::var transitionData) override
  {

      if (!(bool) transitionData) return;

      auto instrument = dynamic_cast<TransitionSample *> (inst);
      if (instrument == nullptr)
      {
          juce::Logger::writeToLog ("Instrument " + juce::String (inst->id) + " is not TransitionSample!");
          return;
      }

      juce::Logger::writeToLog ("Processing " + instrument->name + " in " + segmentName);

      te::TimeRange transitionPlayRange = te::TimeRange
          {
              segmentTimeRange.getStart (),
              segmentTimeRange.getStart () + te::TimeDuration::fromSeconds (instrument->getDuration ())
          };

      te::TimePosition sequenceStartPosition = edit.tempoSequence.toTime (
          te::BeatPosition::fromBeats ((double) transitionData["sequenceStartPosition"]) / 8.0);
      sequenceStartPosition = sequenceStartPosition
                              + te::TimeDuration::fromSeconds ((double) transitionData["sequenceStartPositionOffsetInSeconds"]);
      transitionPlayRange = transitionPlayRange.movedToStartAt (
          transitionPlayRange.getStart () + te::TimeDuration::fromSeconds (sequenceStartPosition.inSeconds ()));

      instrument->createSegmentClip (segmentName, transitionPlayRange, sampleTransitionsTrack);
  }

  void createSegmentClip (const j::String &segName, const te::TimeRange &playTimeRange, te::AudioTrack *track)
  {
      auto waveClip = track->insertWaveClip (segName, sampleFile, te::ClipPosition{playTimeRange}, false);
  }

  int getPatternBarsCount (j::var) override
  {
      auto audioFile = te::AudioFile (edit.engine, sampleFile);
      double audioFileLength = audioFile.getLength ();
      te::tempo::BarsAndBeats b = edit.tempoSequence.toBarsAndBeats (
          te::TimePosition::fromSeconds (audioFileLength));
      return b.bars;
  }

  double getDuration ()
  {return duration;}
  double getClimax ()
  {return climax;}

  void initTracks () override
  {
      // do nothing
  }

  void setSampleTransitionsTrack (te::AudioTrack *newSampleTransitionsTrack)
  {
      sampleTransitionsTrack = newSampleTransitionsTrack;
  }

 private:

  void initSampleFile ()
  {
      juce::DynamicObject::Ptr sampleId{new juce::DynamicObject ()};

      sampleId.get ()->setProperty (j::String (id), id);

      juce::String samplePlayPath = generateSamplePlayPath (baseURL);

      SampleDownloader sampleDownloader;
      FileMapPtr files = sampleDownloader.downloadSamples (
          edit,
          samplePlayPath,
          j::String ("playsample"),
          sampleId
      );


      if (files.get ()->empty ())
      {
          juce::Logger::writeToLog ("TransitionSample " + juce::String (id) + " has no downloaded sample files; skipping load.");
          return;
      }

      sampleFile = j::File::getCurrentWorkingDirectory ().getChildFile (files.get ()->begin ()->second);
  }

  int bpm;
  double duration;
  double climax;
  j::String original;

  j::File sampleFile;

  te::AudioTrack *sampleTransitionsTrack = nullptr;
};

