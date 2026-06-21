//
// Created by Tiago Alves on 15/05/2022.
//

#pragma once

#include "TonalInstrument.h"
//#include "SamplesDownloadTask.cpp"
#include "SequencerUtils.h"

class Guitar : public TonalInstrument {
 public:
  Guitar (te::Edit &edit, const j::var &instrumentData, juce::String baseURL)
      : TonalInstrument (edit, instrumentData, baseURL)
  {
      sampleData = instrumentData["samples"];
      if (instrumentData["fx"]["fxFretNoise"])
          fretNoiseData = instrumentData["fx"]["fxFretNoise"];

      if (instrumentData["virtualGuitaristSamples"])
          virtualGuitaristSampleData = instrumentData["virtualGuitaristSamples"];

      defaultVolume = -20 + (-10 - LUFS);

      TRACKTION_LOG("Guitar created!");

      initPlugins ();
  }

  ~Guitar ()
  {
      longNoteIds.reset ();
      shortNoteIds.reset ();
      fretNoiseIds.reset ();
      juce::Logger::writeToLog ("Successfully destroyed guitar");
  }

  j::Array<te::AudioTrack *> getAudioTracks () override
  {
      return j::Array<te::AudioTrack *>{shortNotesTrack, longNotesTrack, fretNoisesTrack, guitarStrumsTrack};
  }

  void createSegmentClip (const j::String &segName,
                          const te::TimeRange &segTimeRange,
                          const te::TimeRange &loopTimeRange,
                          const j::Array<TimeNote> &timeNotes,
                          const j::Array<TimeStrums> &timeStrums,
                          const j::var &mute) override
  {
      if (timeNotes.size () > 0)
      {
          auto shortNotesMidiClip = static_cast<te::MidiClip *> (shortNotesTrack->insertNewClip (
              te::TrackItem::Type::midi, segName, segTimeRange, nullptr));
          shortNotesMidiClip->setLoopRange (loopTimeRange);

          jassert (shortNotesMidiClip != nullptr);

          auto longNotesMidiClip = static_cast<te::MidiClip *> (longNotesTrack->insertNewClip (
              te::TrackItem::Type::midi, segName, segTimeRange, nullptr));
          longNotesMidiClip->setLoopRange (loopTimeRange);

          jassert (longNotesMidiClip != nullptr);

          auto fretNoisesMidiClip =
              static_cast<te::MidiClip *> (fretNoisesTrack->insertNewClip (
                  te::TrackItem::Type::midi, segName, segTimeRange, nullptr));
          auto fretNoisesSequence = &fretNoisesMidiClip->getSequence ();
          fretNoisesMidiClip->setLoopRange (loopTimeRange);

          jassert (fretNoisesMidiClip != nullptr);

          for (auto timeNote: timeNotes)
          {
              if (timeNote.type == TimeNote::Type::tonal)
              {
                  if (timeNote.duration > 0.5)
                  {
                      addNoteToClip (longNotesMidiClip, timeNote, VelocityMode::randomised);
                  }
                  else
                  {
                      addNoteToClip (shortNotesMidiClip, timeNote, VelocityMode::randomised);
                  }

              }
              else if (timeNote.type == TimeNote::Type::fretNoise)
              {
                  fretNoisesSequence->addNote (timeNote.note.midiNote, te::BeatPosition::fromBeats (timeNote.start),
                                               te::BeatDuration::fromBeats (timeNote.duration), timeNote.velocity, 1,
                                               nullptr);
              }
          }

          applyMuteToTrack (shortNotesTrack, segTimeRange, mute);
          applyMuteToTrack (longNotesTrack, segTimeRange, mute);
          applyMuteToTrack (fretNoisesTrack, segTimeRange, mute);
      }

      if (timeStrums.size () > 0)
      {
          // create midi clip (strums chords)
          auto clip1 = guitarStrumsTrack->insertNewClip (te::TrackItem::Type::midi, segName, segTimeRange, nullptr);
          te::MidiClip *guitarStrumsClip = dynamic_cast<te::MidiClip *> (clip1);
          guitarStrumsClip->setLoopRange (loopTimeRange);

          // create step clip (strums fx)
          auto clip2 = guitarStrumsTrack->insertNewClip (te::TrackItem::Type::step, segName, segTimeRange, nullptr);
          te::StepClip *guitarStrumsStepClip = dynamic_cast<te::StepClip *> (clip2);
          auto clipPattern = guitarStrumsStepClip->getPattern (0);
          int beats = edit.tempoSequence.toBeats (segTimeRange).getLength ().inBeats ();
          clipPattern.setNumNotes (8 * beats);
          clipPattern.setNoteLength (te::BeatDuration::fromBeats (1.0 / 8));
          clip2->setLoopRange (loopTimeRange);
          // remove all channels
          for (int i = guitarStrumsStepClip->getChannels ().size (); --i >= 0;)
          {
              guitarStrumsStepClip->removeChannel (i);
          }

          for (auto timeStrum: timeStrums)
          {
              if (timeStrum.duration != -1)
              {
                  // docs/54m: addNote expects a MIDI note; ensureSampleMidiNote
                  // returns the sound INDEX. Look up the slot's keyNote.
                  int soundIndex = ensureSampleMidiNote (timeStrum, guitarStrumsStepClip);
                  tracktion_engine::SamplerPlugin *samplerPlugin = dynamic_cast<tracktion_engine::SamplerPlugin *> (guitarStrumsSamplerPlugin.get ());
                  int midiNote = samplerPlugin->getKeyNote (soundIndex);
                  double soundLength = samplerPlugin->getSoundLength (soundIndex);
                  (void) soundLength;

                  auto guitarStrumsSequence = &guitarStrumsClip->getSequence ();
                  guitarStrumsSequence->addNote (midiNote, te::BeatPosition::fromBeats (timeStrum.start),
                                                 te::BeatDuration::fromBeats (timeStrum.duration), timeStrum.velocity, 1,
                                                 nullptr);
              }
              else
              {
                  int channelIndex = ensureSampleMidiNote (timeStrum, guitarStrumsStepClip);
                  clipPattern.setNote (channelIndex, (int) (timeStrum.start * 8), true);
              }
          }

          applyMuteToTrack (guitarStrumsTrack, segTimeRange, mute);
      }
  }

  void initTracks () override
  {
      int currNumTracks = te::getAudioTracks (edit).size ();
      edit.ensureNumberOfAudioTracks (currNumTracks + 4);

      shortNotesTrack = te::getAudioTracks (edit)[currNumTracks];
      j::String shortNotesTrackName = j::String (name);
      shortNotesTrackName << "(short notes)";
      shortNotesTrack->setName (shortNotesTrackName);

      longNotesTrack = te::getAudioTracks (edit)[currNumTracks + 1];
      j::String longNotesTrackName = j::String (name);
      longNotesTrackName << "(long notes)";
      longNotesTrack->setName (longNotesTrackName);

      fretNoisesTrack = te::getAudioTracks (edit)[currNumTracks + 2];
      j::String fretNoisesTrackName = j::String (name);
      fretNoisesTrackName << "(fret noises)";
      fretNoisesTrack->setName (fretNoisesTrackName);

      guitarStrumsTrack = te::getAudioTracks (edit)[currNumTracks + 3];
      j::String guitarStrumsTrackName = j::String (name);
      guitarStrumsTrackName << "(strums)";
      guitarStrumsTrack->setName (guitarStrumsTrackName);

      jassert (shortNotesTrack != nullptr);
      jassert (longNotesTrack != nullptr);
      jassert (fretNoisesTrack != nullptr);
      jassert (guitarStrumsSamplerPlugin != nullptr);

      shortNotesTrack->pluginList.insertPlugin (shortNotesSamplerPlugin, 0, nullptr);
      longNotesTrack->pluginList.insertPlugin (longNotesSamplerPlugin, 0, nullptr);
      fretNoisesTrack->pluginList.insertPlugin (fretNoisesSamplerPlugin, 0, nullptr);
      guitarStrumsTrack->pluginList.insertPlugin (guitarStrumsSamplerPlugin, 0, nullptr);
  }

 private:
  void initPlugins ()
  {
      auto samples = sampleData.getArray ();
      for (auto sample: *samples)
      {
          j::DynamicObject::Ptr sampleObj = sample.getDynamicObject ();
          if (sampleObj->getProperty ("type") == "longNote")
          {
              longNoteIds.get ()->setProperty (sampleObj->getProperty ("note").toString (), (int) sampleObj->getProperty ("id"));
          }
          else
          {
              shortNoteIds.get ()->setProperty (sampleObj->getProperty ("note").toString (), (int) sampleObj->getProperty ("id"));
          }
          sampleObj->clear ();
      }

      shortNotesSamplerPlugin = edit.getPluginCache ().createNewPlugin (te::SamplerPlugin::xmlTypeName, {});
      longNotesSamplerPlugin = edit.getPluginCache ().createNewPlugin (te::SamplerPlugin::xmlTypeName, {});

      juce::String sampleLoadPath = generateSampleLoadPath (baseURL);

      SampleDownloader sampleDownloader;

      FileMapPtr sampleLongFiles = sampleDownloader.downloadSamples (
          edit,
          sampleLoadPath,
          "vstsample",
          longNoteIds
      );

      createNotesSampler (sampleLongFiles, true);

      FileMapPtr sampleShortFiles = sampleDownloader.downloadSamples (
          edit,
          sampleLoadPath,
          "vstsample",
          shortNoteIds
      );

      createNotesSampler (sampleShortFiles, false);

      juce::String samplePlayPath = generatePath (baseURL, "playSample/");
      if (!fretNoiseData.isVoid ())
      {
          samples = fretNoiseData.getArray ();
          for (int i = 0; i < samples->size (); i++)
          {
              fretNoiseIds.get ()->setProperty (j::String{i}, (*samples)[i]);
          }
          FileMapPtr fretNoiseFiles = sampleDownloader.downloadSamples (edit, samplePlayPath, "playsample", fretNoiseIds);

          fretNoisesSamplerPlugin = edit.getPluginCache ().createNewPlugin (te::SamplerPlugin::xmlTypeName, {});
          jassert (fretNoisesSamplerPlugin.get () != nullptr);
          createFretNoiseSampler (fretNoiseFiles);
      }

      guitarStrumsSamplerPlugin = edit.getPluginCache ().createNewPlugin (te::SamplerPlugin::xmlTypeName, {});
      jassert(guitarStrumsSamplerPlugin != nullptr);
  }

  int ensureSampleMidiNote (TimeStrums timeStrums, te::StepClip *stepClip)
  {
      te::SamplerPlugin *samplerPlugin = dynamic_cast<te::SamplerPlugin *> (guitarStrumsSamplerPlugin.get ());

      // There are only virtual guitar samples for major, 11, 6, 7, 9, m, m7, sus2, sus4 chords
      // So we need to convert the chord to one of these types
      j::String virtualGuitaristChord = timeStrums.chord.getRootNote ().toString (false);
      switch (timeStrums.chord.getType ())
      {
          case Chord::ChordType::major:
          case Chord::ChordType::Mdim:
          case Chord::ChordType::M5:
          case Chord::ChordType::Malt:
          case Chord::ChordType::Maug:
              virtualGuitaristChord += ""; // no suffix, use major
              break;
          case Chord::ChordType::Mdim7:
          case Chord::ChordType::M7:
          case Chord::ChordType::M7b5:
          case Chord::ChordType::Maug7:
          case Chord::ChordType::M7b9:
          case Chord::ChordType::M7s9:
          case Chord::ChordType::Mmaj7:
          case Chord::ChordType::Mmaj7b5:
          case Chord::ChordType::Mmaj7s5:
              virtualGuitaristChord += "7"; // use 7
              break;
          case Chord::ChordType::Msus2:
              virtualGuitaristChord += "sus2"; // use 7
              break;
          case Chord::ChordType::Msus4:
          case Chord::ChordType::M7sus4:
              virtualGuitaristChord += "sus4"; // use 7
              break;
          case Chord::ChordType::M6:
          case Chord::ChordType::M69:
          case Chord::ChordType::M13:
          case Chord::ChordType::Mmaj13:
              virtualGuitaristChord += "6"; // use 6
              break;
          case Chord::ChordType::M9:
          case Chord::ChordType::M9b5:
          case Chord::ChordType::Maug9:
          case Chord::ChordType::M9s11:
          case Chord::ChordType::Mmaj9:
          case Chord::ChordType::Madd9:
              virtualGuitaristChord += "9"; // use 7
              break;
          case Chord::ChordType::M11:
          case Chord::ChordType::Mmaj11:
              virtualGuitaristChord += "9"; // use 7
              break;

          case Chord::ChordType::minor:
          case Chord::ChordType::m6:
          case Chord::ChordType::m9:
          case Chord::ChordType::m69:
          case Chord::ChordType::mmaj9:
          case Chord::ChordType::m11:
          case Chord::ChordType::mmaj11:
          case Chord::ChordType::madd9:
              virtualGuitaristChord += "m"; // use 7
              break;
          case Chord::ChordType::m7:
          case Chord::ChordType::m7b5:
          case Chord::ChordType::mmaj7:
          case Chord::ChordType::mmaj7b5:
              virtualGuitaristChord += "m7"; // use 7
              break;
          case Chord::invalidChord:
              break;
      }

      j::String sampleKey = (timeStrums.type == TimeStrums::Type::fx)
          ? timeStrums.fxName
          : (virtualGuitaristChord + "_" + j::String{timeStrums.chordPosition} + "_"
             + timeStrums.typeAsString ());

      ////// ensure sample in plugin

      SampleDownloader sampleDownloader;

      int soundIndex = getPluginSoundIndex (sampleKey);
      if (soundIndex == -1) // if not found, load it
      {
          for (auto sample: *virtualGuitaristSampleData.getArray ())
          {
//              DBG("my Note: " << currentChord.toString (true) << " " << chordPos << " " << strumType
//              << " | sample: " << sample["chord"].toString () << " " << sample["chordPosition"].toString () << " " << sample["type"].toString ()
//              );
              // support fx events (not tested yet)
              juce::StringRef fxStr{"fx"};
              if (
                  (sample["chord"].toString () == virtualGuitaristChord &&
                   sample["chordPosition"].toString ().getIntValue () == timeStrums.chordPosition &&
                   sample["type"].toString () == timeStrums.typeAsString ())
                  ||
                  (timeStrums.type == TimeStrums::Type::fx && sample["fx"].toString () == timeStrums.fxName)
                  )
              {
                  juce::DynamicObject::Ptr idsToLoad{new juce::DynamicObject ()};
                  idsToLoad.get ()->setProperty (sampleKey, (int) sample["id"]);

                  juce::String sampleLoadPath = baseURL + "/virtualGuitaristSample/load/";

                  FileMapPtr sampleFiles = sampleDownloader.downloadSamples (edit, sampleLoadPath, "playsample", idsToLoad);
                  //
                  //      createSampler (sampleFiles);

                  juce::Logger::writeToLog ("Files have been downloaded for the strummer.");

                  // should be only one, but in the future we might have multiple samples
                  for (auto it = sampleFiles.get ()->begin (); it != sampleFiles.get ()->end (); it++)
                  {
                      // docs/54m: keyNote = soundIndex + 48 (the nearby
                      // `midiNoteIndex - 48` already assumed this offset).
                      static constexpr int kStrumSoundIndexToMidiOffset = 48;
                      int noteNumber = samplerPlugin->getNumSounds () + kStrumSoundIndexToMidiOffset;

                      const auto error = samplerPlugin->addSound (it->second, it->first, 0.0, 0.0, 0.0f);
                      jassert (error.isEmpty ());
                      int index = samplerPlugin->getNumSounds () - 1;
                      samplerPlugin->setSoundParams (index, noteNumber, noteNumber, noteNumber);
                      samplerPlugin->setSoundOpenEnded (index, true);
                  }
                  soundIndex = getPluginSoundIndex (sampleKey);
                  break;
              }
          }
      }

      juce::Logger::writeToLog ("Sound index has been retrieved.");

      if (soundIndex == -1) throw std::runtime_error ("Could not create sound for sample " + sampleKey.toStdString ());

      if (stepClip != nullptr && stepClip->getChannels ()[soundIndex] == nullptr && soundIndex >= 0)
      {
          te::StepClip::Channel *channel = nullptr;
          while (channel == nullptr)
          {
              stepClip->insertNewChannel (soundIndex);
              channel = stepClip->getChannels ()[soundIndex];
          }

          jassert (channel != nullptr);

          if (channel != nullptr)
          {
              auto keyNote = samplerPlugin->getKeyNote (soundIndex);
              channel->noteNumber.setValue (keyNote, nullptr);
              channel->name.setValue (sampleKey, nullptr);
              return soundIndex;
          }
      }

      return soundIndex;
  }

  int getPluginSoundIndex (j::String sampleKey)
  {
      te::SamplerPlugin *samplerPlugin = dynamic_cast<te::SamplerPlugin *> (guitarStrumsSamplerPlugin.get ());
      // check is sample is already in sampler

      for (int i = 0; i < samplerPlugin->getNumSounds (); i++)
      {
          auto soundName = samplerPlugin->getSoundName (i);
          if (soundName == sampleKey)
          {
              return i;
          }
      }
      return -1;
  }

  void playNote (std::string noteDataStr) override
  {
      if (longNotesSamplerPlugin.get () == nullptr)
      {
          juce::Logger::writeToLog ("Notes Sampler Plugin has not been created");
          return;
      }

      // We obtain a pointer to the SamplerPlugin object
      auto samplerPluginNotes = dynamic_cast<te::SamplerPlugin *>(longNotesSamplerPlugin.get ());
      //      auto samplerPluginFrets = dynamic_cast<te::SamplerPlugin *>(fretNoisesSamplerPlugin.get());

      juce::var parsedNoteData = juce::JSON::parse (juce::String (noteDataStr));
      auto timeNotes =
          getRealNotes (parsedNoteData, *new Chord ("C"), *new Chord ("C"));

      juce::BigInteger noteKeysHeldDown, fretKeysHeldDown, strummedChordKeysHeldDown;
      samplerPluginNotes->playNotes (
          noteKeysHeldDown); // We let go of all of the keys
      //      samplerPluginFrets->playNotes (fretKeysHeldDown);

      for (auto timeNote: timeNotes)
      {
          if (timeNote.type == TimeNote::Type::tonal)
          {
              noteKeysHeldDown.setBit (timeNote.note.midiNote + 12);
          }
      }

      samplerPluginNotes->playNotes (noteKeysHeldDown); // And then we play the new note
      //      samplerPluginFrets->playNotes(fretKeysHeldDown);
  }

  void createNotesSampler (FileMapPtr files, bool isLongNotes)
  {
      juce::Logger::writeToLog ("SAMPLES DOWNLOADED FOR " + juce::String (isLongNotes ? "LONG NOTES" : "SHORT NOTES"));

      // init sampler
      std::map<int, j::String> midiNoteFiles{};

      te::SamplerPlugin *samplerPlugin;
      if (isLongNotes)
      {
          samplerPlugin = dynamic_cast<te::SamplerPlugin *> (longNotesSamplerPlugin.get ());
      }
      else
      {
          samplerPlugin = dynamic_cast<te::SamplerPlugin *> (shortNotesSamplerPlugin.get ());
      }

      jassert (samplerPlugin != nullptr);

      // transform unordered notes into ordered (midi) notes
      for (auto it = files.get ()->begin (); it != files.get ()->end (); it++)
      {
          juce::String fullPathName = juce::File::getCurrentWorkingDirectory ().getChildFile (it->second).getFullPathName ();
          juce::Logger::writeToLog (fullPathName);
          jassert (juce::File (fullPathName).existsAsFile());

          midiNoteFiles.insert (std::pair<int, j::String>{
              getMidiNoteNumber (it->first), fullPathName});
          juce::Logger::writeToLog ("Added note: " + j::String{getMidiNoteNumber (it->first)});
      }

      int zoneStart = 0, zoneEnd = 0;

      for (auto it = midiNoteFiles.begin (); it != midiNoteFiles.end (); it++)
      {
          //                DBG( "sorted note: " << it->first << " -> " <<
          //                it->second );
          juce::String fullPathName = it->second;
          DBG (fullPathName);
          jassert (juce::File (fullPathName).existsAsFile());

          const auto error = samplerPlugin->addSound (makeRelative (fullPathName), getMidiNoteName (it->first), 0.0, 0.0, 0.0f);
          jassert(error.isEmpty ());

          auto next = std::next (it, 1);
          if (next == midiNoteFiles.end ())
          {
              zoneEnd = 180;
          }
          else
          {
              zoneEnd = it->first + (next->first - it->first) / 2;
          }

          samplerPlugin->setSoundParams (samplerPlugin->getNumSounds () - 1,
                                         it->first, zoneStart, zoneEnd);
          //                DBG( "Added sample note: " << it->first << " -> " <<
          //                zoneStart << "-" << zoneEnd );
          zoneStart = zoneEnd + 1;
      }
  }

  void createFretNoiseSampler (FileMapPtr files)
  {
      te::SamplerPlugin *samplerPlugin = dynamic_cast<te::SamplerPlugin *> (fretNoisesSamplerPlugin.get ());
      jassert(samplerPlugin != nullptr);

      for (auto it = files.get ()->begin (); it != files.get ()->end (); it++)
      {
          int noteNumber = it->first.getIntValue ();

          juce::Logger::writeToLog (
              "fret note: " + juce::String (it->first) + " number: " + juce::String (noteNumber) + " -> " + it->second);

          const auto error = samplerPlugin->addSound (it->second, it->first, 0.0, 0.0, 0.0f);
          jassert (error.isEmpty ());
          samplerPlugin->setSoundParams (samplerPlugin->getNumSounds () - 1, noteNumber, noteNumber, noteNumber);
      }
      juce::Logger::writeToLog ("set fretNoisesSamplerPlugin");

      ready = true;
  }

  juce::DynamicObject::Ptr longNoteIds{new juce::DynamicObject ()};
  juce::DynamicObject::Ptr shortNoteIds{new juce::DynamicObject ()};
  juce::DynamicObject::Ptr fretNoiseIds{new juce::DynamicObject ()};

  te::AudioTrack *shortNotesTrack = nullptr;
  te::AudioTrack *longNotesTrack = nullptr;
  te::AudioTrack *fretNoisesTrack = nullptr;
  te::AudioTrack *guitarStrumsTrack = nullptr;

  te::SamplerPlugin::Ptr shortNotesSamplerPlugin;
  te::SamplerPlugin::Ptr longNotesSamplerPlugin;
  te::SamplerPlugin::Ptr fretNoisesSamplerPlugin;
  te::SamplerPlugin::Ptr guitarStrumsSamplerPlugin;

  j::var sampleData;
  j::var fretNoiseData{};
  j::var virtualGuitaristSampleData{};
};
