/*
  ==============================================================================

    CasperakiSamplerPlugin.cpp
    Created: 31 Jul 2023 12:19:47pm
    Author:  Abhishek Shivakumar

  ==============================================================================
*/

#include "CasperakiSamplerPlugin.h"

namespace tracktion { inline namespace engine
{

// this must be high enough for low freq sounds not to click
static constexpr int minimumSamplesToPlayWhenStopping = 8;
static constexpr int maximumSimultaneousNotes = 32;


struct CasperakiSamplerPlugin::SampledNote   : public ReferenceCountedObject
{
    juce::ADSR adsr;
public:
    SampledNote (int midiNote, int keyNote,
                 float velocity,
                 const AudioFile& file,
                 double sampleRate,
                 int sampleDelayFromBufferStart,
                 const juce::AudioBuffer<float>& data,
                 int lengthInSamples,
                 float gainDb,
                 float pan,
                 bool openEnded_)
       : note (midiNote),
         offset (-sampleDelayFromBufferStart),
         audioData (data),
         openEnded (openEnded_)
    {
        resampler[0].reset();
        resampler[1].reset();

        const float volumeSliderPos = decibelsToVolumeFaderPosition (gainDb - (20.0f * (1.0f - velocity)));
        getGainsFromVolumeFaderPositionAndPan (volumeSliderPos, pan, getDefaultPanLaw(), gains[0], gains[1]);

        const double hz = juce::MidiMessage::getMidiNoteInHertz (midiNote);
        playbackRatio = hz / juce::MidiMessage::getMidiNoteInHertz (keyNote);
        playbackRatio *= file.getSampleRate() / sampleRate;
        samplesLeftToPlay = playbackRatio > 0 ? (1 + (int) (lengthInSamples / playbackRatio)) : 0;
        
        adsr.setSampleRate (44100);
        adsr.setParameters (juce::ADSR::Parameters (0.001f, 0.1f, 1.0f, 2.0f));
    }

    
    // This function adds the next block of audio data to the output buffer.
    // It takes in the output buffer, the starting sample, and the number of samples as parameters.
    // It uses a resampler to process the audio data, and it fades out the audio if the end of the audio clip is reached.
    // It also checks to make sure the offset is not negative, and it checks to make sure the number of samples is not greater than the number of samples left to play.
    void addNextBlock(juce::AudioBuffer<float>& outBuffer, int startSamp, int numSamples)
    {
        jassert(!isFinished);

        if (offset < 0)
        {
            const int num = std::min(-offset, numSamples);
            startSamp += num;
            numSamples -= num;
            offset += num;
        }

        //numSamps is a constrained version of numSamples, that doesn't overshoot the buffers sample size
        auto numSamps = std::min (numSamples, samplesLeftToPlay); //num samples left to play

        if (numSamps > 0) //If there are still samples left to play
        {
            int numUsed = 0;

            for (int i = std::min(2, outBuffer.getNumChannels()); --i >= 0;)
            {
                numUsed = resampler[i].processAdding(playbackRatio,
                                                     audioData.getReadPointer(std::min(i, audioData.getNumChannels() - 1), offset),
                                                     outBuffer.getWritePointer(i, startSamp),
                                                     numSamps,
                                                     gains[i]); // Apply envelope here
            }



            offset += numUsed;
            samplesLeftToPlay -= numSamps;

            jassert(offset <= audioData.getNumSamples());
        }

        if (numSamples > numSamps && startFade > 0.0f)
        {
            startSamp += numSamps;
            numSamps = numSamples - numSamps;
            float endFade;

            if (numSamps > 100)
            {
                endFade = 0.0f;
                numSamps = 100;
            }
            else
            {
                endFade = std::max(0.0f, startFade - numSamps * 0.01f);
            }

            const int numSampsNeeded = 2 + juce::roundToInt((numSamps + 2) * playbackRatio);
            AudioScratchBuffer scratch(audioData.getNumChannels(), numSampsNeeded + 8);

            if (offset + numSampsNeeded < audioData.getNumSamples())
            {
                for (int i = scratch.buffer.getNumChannels(); --i >= 0;)
                    scratch.buffer.copyFrom(i, 0, audioData, i, offset, numSampsNeeded);
            }
            else
            {
                scratch.buffer.clear();
            }

            if (numSampsNeeded > 2)
                AudioFadeCurve::applyCrossfadeSection (scratch.buffer, 0, numSampsNeeded - 2,
                                                      AudioFadeCurve::linear, startFade, endFade);

            startFade = endFade;

            int numUsed = 0;

            for (int i = std::min(2, outBuffer.getNumChannels()); --i >= 0;)
                numUsed = resampler[i].processAdding (playbackRatio,
                                                     scratch.buffer.getReadPointer(std::min(i, scratch.buffer.getNumChannels() - 1)),
                                                     outBuffer.getWritePointer (i, startSamp),
                                                     numSamps, gains[i]); // Apply envelope here

            offset += numUsed;

            if (startFade <= 0.0f)
                isFinished = true;
        }

#if SHOULD_APPLY_ADSR
        adsr.applyEnvelopeToBuffer (outBuffer, startSamp, numSamps);
#endif
    }


    juce::LagrangeInterpolator resampler[2];
    int note;
    int offset, samplesLeftToPlay = 0;
    float gains[2];
    double playbackRatio = 1.0;
    const juce::AudioBuffer<float>& audioData;
    float lastVals[4] = { 0, 0, 0, 0 };
    float startFade = 1.0f;
    bool openEnded, isFinished = false;

private:
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SampledNote)
};

//==============================================================================
CasperakiSamplerPlugin::CasperakiSamplerPlugin (PluginCreationInfo info)  : Plugin (info)
{
    triggerAsyncUpdate();
    adsr.reset();
}

CasperakiSamplerPlugin::~CasperakiSamplerPlugin()
{
    notifyListenersOfDeletion();
}

const char* CasperakiSamplerPlugin::xmlTypeName = "casperakiSampler";

void CasperakiSamplerPlugin::valueTreeChanged()
{
    triggerAsyncUpdate();
    Plugin::valueTreeChanged();
}

void CasperakiSamplerPlugin::handleAsyncUpdate()
{
    juce::OwnedArray<SamplerSound> newSounds;

    auto numSounds = state.getNumChildren();

    for (int i = 0; i < numSounds; ++i)
    {
        auto v = getSound (i);

        if (v.hasType (IDs::SOUND))
        {
            auto s = new SamplerSound (*this,
                                       v[IDs::source].toString(),
                                       v[IDs::name],
                                       v[IDs::startTime],
                                       v[IDs::length],
                                       v[IDs::gainDb]);

            s->keyNote      = juce::jlimit (0, 127, static_cast<int> (v[IDs::keyNote]));
            s->minNote      = juce::jlimit (0, 127, static_cast<int> (v[IDs::minNote]));
            s->maxNote      = juce::jlimit (0, 127, static_cast<int> (v[IDs::maxNote]));
            s->pan          = juce::jlimit (-1.0f, 1.0f, static_cast<float> (v[IDs::pan]));
            s->openEnded    = v[IDs::openEnded];

            newSounds.add (s);
        }
    }

    for (auto newSound : newSounds)
    {
        for (auto s : soundList)
        {
            if (s->source == newSound->source
                && s->startTime == newSound->startTime
                && s->length == newSound->length)
            {
                newSound->audioFile = s->audioFile;
                newSound->fileStartSample = s->fileStartSample;
                newSound->fileLengthSamples = s->fileLengthSamples;
                newSound->audioData = s->audioData;
            }
        }
    }

    {
        const juce::ScopedLock sl (lock);
        allNotesOff();
        soundList.swapWith (newSounds);

        sourceMediaChanged();
    }

    newSounds.clear();
    changed();
}

void CasperakiSamplerPlugin::initialise (const PluginInitialisationInfo&)
{
    const juce::ScopedLock sl (lock);
    allNotesOff();
}

void CasperakiSamplerPlugin::deinitialise()
{
    allNotesOff();
}

//==============================================================================
void CasperakiSamplerPlugin::playNotes (const juce::BigInteger& keysDown)
{
    const juce::ScopedLock sl (lock);

    if (highlightedNotes != keysDown)
    {
        for (int i = playingNotes.size(); --i >= 0;)
            if ((! keysDown [playingNotes.getUnchecked(i)->note])
                 && highlightedNotes [playingNotes.getUnchecked(i)->note]
                 && ! playingNotes.getUnchecked(i)->openEnded)
                playingNotes.getUnchecked(i)->samplesLeftToPlay = minimumSamplesToPlayWhenStopping;

        for (int note = 128; --note >= 0;)
        {
            if (keysDown [note] && ! highlightedNotes [note])
            {
                for (auto ss : soundList)
                {
                    if (ss->minNote <= note
                         && ss->maxNote >= note
                         && ss->audioData.getNumSamples() > 0
                         && (! ss->audioFile.isNull())
                         && playingNotes.size() < maximumSimultaneousNotes)
                    {
                        //My intuition tells me that this adds notes to the playing list to be handled asynchronously
                        auto playingNoteToAdd = new SampledNote (note,
                                                                 ss->keyNote,
                                                                 0.75f,
                                                                 ss->audioFile,
                                                                 sampleRate,
                                                                 0,
                                                                 ss->audioData,
                                                                 ss->fileLengthSamples,
                                                                 ss->gainDb,
                                                                 ss->pan,
                                                                 ss->openEnded);
                        
                        playingNoteToAdd->adsr.noteOn();
                        playingNotes.add (playingNoteToAdd);
                        
                    }
                }
            }
        }

        highlightedNotes = keysDown;
    }
}

void CasperakiSamplerPlugin::allNotesOff()
{
    const juce::ScopedLock sl (lock);
    playingNotes.clear();
    highlightedNotes.clear();
}

// This code applies the CasperakiSamplerPlugin to the given buffer.
// It checks for MIDI messages and adds playing notes or stops playing notes accordingly.
// If playing notes, it adds the next block of samples to the destination buffer.
// It also removes finished playing notes.
void CasperakiSamplerPlugin::applyToBuffer (const PluginRenderContext& fc)
{
    if (fc.destBuffer != nullptr)
    {
        SCOPED_REALTIME_CHECK
        
        const juce::ScopedLock sl (lock);
        
        clearChannels (*fc.destBuffer, 2, -1, fc.bufferStartSample, fc.bufferNumSamples);
        
        if (fc.bufferForMidiMessages != nullptr)
        {
            if (fc.bufferForMidiMessages->isAllNotesOff)
            {
                playingNotes.clear();
                highlightedNotes.clear();
            }
            
            for (auto& m : *fc.bufferForMidiMessages)
            {
                if (m.isNoteOn())
                {
                    const int note = m.getNoteNumber();
                    const int noteTimeSample = juce::roundToInt (m.getTimeStamp() * sampleRate);
                    
                    for (auto playingNote : playingNotes)
                    {
                        if (playingNote->note == note && ! playingNote->openEnded)
                        {
                            playingNote->samplesLeftToPlay = std::min (playingNote->samplesLeftToPlay,
                                                                       std::max (minimumSamplesToPlayWhenStopping,
                                                                                 noteTimeSample));
                            highlightedNotes.clearBit (note);
                        }
                    }
                    
                    for (auto ss : soundList)
                    {
                        if (ss->minNote <= note
                            && ss->maxNote >= note
                            && ss->audioData.getNumSamples() > 0
                            && playingNotes.size() < maximumSimultaneousNotes)
                        {
                            highlightedNotes.setBit (note);
                            
                            //My intuition tells me that this adds notes to the playing list to be handled asynchronously
                            auto playingNoteToAdd = new SampledNote (note,
                                                                     ss->keyNote,
                                                                     0.75f,
                                                                     ss->audioFile,
                                                                     sampleRate,
                                                                     0,
                                                                     ss->audioData,
                                                                     ss->fileLengthSamples,
                                                                     ss->gainDb,
                                                                     ss->pan,
                                                                     ss->openEnded);
                            
                            playingNoteToAdd->adsr.noteOn();
                            playingNotes.add (playingNoteToAdd);
                        }
                    }
                }
                else if (m.isNoteOff())
                {
                    const int note = m.getNoteNumber();
                    const int noteTimeSample = juce::roundToInt (m.getTimeStamp() * sampleRate);
                    
                    for (auto playingNote : playingNotes)
                    {
                        if (playingNote->note == note)
                        {
                            playingNote->adsr.noteOff();
                        }
                        if (playingNote->note == note && ! playingNote->openEnded)
                        {
                            playingNote->samplesLeftToPlay = std::min (playingNote->samplesLeftToPlay,
                                                                       std::max             (minimumSamplesToPlayWhenStopping, noteTimeSample));
                            
                            highlightedNotes.clearBit (note);
                        }
                    }
                }
                else if (m.isAllNotesOff() || m.isAllSoundOff())
                {
                    playingNotes.clear();
                    highlightedNotes.clear();
                }
            }
        }
        
        for (int i = playingNotes.size(); --i >= 0;)
        {
            auto sn = playingNotes.getUnchecked (i);
            
            sn->addNextBlock (*fc.destBuffer, fc.bufferStartSample, fc.bufferNumSamples);
            
            if (sn->isFinished)
                playingNotes.remove (i);
        }
    }
}

//==============================================================================
int CasperakiSamplerPlugin::getNumSounds() const
{
    return std::accumulate (state.begin(), state.end(), 0,
                            [] (int total, auto v) { return total + (v.hasType (IDs::SOUND) ? 1 : 0); });
}

juce::String CasperakiSamplerPlugin::getSoundName (int index) const
{
    return getSound (index)[IDs::name];
}

void CasperakiSamplerPlugin::setSoundName (int index, const juce::String& n)
{
    getSound (index).setProperty (IDs::name, n, getUndoManager());
}

bool CasperakiSamplerPlugin::hasNameForMidiNoteNumber (int note, int, juce::String& noteName)
{
    juce::String s;

    {
        const juce::ScopedLock sl (lock);

        for (auto ss : soundList)
        {
            if (ss->minNote <= note && ss->maxNote >= note)
            {
                if (s.isNotEmpty())
                    s << " + " << ss->name;
                else
                    s = ss->name;
            }
        }
    }

    noteName = s;
    return true;
}

AudioFile CasperakiSamplerPlugin::getSoundFile (int index) const
{
    const juce::ScopedLock sl (lock);

    if (auto s = soundList[index])
        return s->audioFile;

    return AudioFile (edit.engine);
}

juce::String CasperakiSamplerPlugin::getSoundMedia (int index) const
{
    const juce::ScopedLock sl (lock);

    if (auto s = soundList[index])
        return s->source;

    return {};
}

int CasperakiSamplerPlugin::getKeyNote (int index) const             { return getSound (index)[IDs::keyNote]; }
int CasperakiSamplerPlugin::getMinKey (int index) const              { return getSound (index)[IDs::minNote]; }
int CasperakiSamplerPlugin::getMaxKey (int index) const              { return getSound (index)[IDs::maxNote]; }
float CasperakiSamplerPlugin::getSoundGainDb (int index) const       { return getSound (index)[IDs::gainDb]; }
float CasperakiSamplerPlugin::getSoundPan (int index) const          { return getSound (index)[IDs::pan]; }
double CasperakiSamplerPlugin::getSoundStartTime (int index) const   { return getSound (index)[IDs::startTime]; }
bool CasperakiSamplerPlugin::isSoundOpenEnded (int index) const      { return getSound (index)[IDs::openEnded]; }

double CasperakiSamplerPlugin::getSoundLength (int index) const
{
    const double l = getSound (index)[IDs::length];

    if (l == 0.0)
    {
        const juce::ScopedLock sl (lock);

        if (auto s = soundList[index])
            return s->length;
    }

    return l;
}

juce::String CasperakiSamplerPlugin::addSound (const juce::String& source, const juce::String& name,
                                      double startTime, double length, float gainDb)
{
    const int maxNumSamples = 64;

    if (getNumSounds() >= maxNumSamples)
        return TRANS("Can't load any more samples");

    auto v = createValueTree (IDs::SOUND,
                              IDs::source, source,
                              IDs::name, name,
                              IDs::startTime, startTime,
                              IDs::length, length,
                              IDs::keyNote, 72,
                              IDs::minNote, 72 - 24,
                              IDs::maxNote, 72 + 24,
                              IDs::gainDb, gainDb,
                              IDs::pan, (double) 0);

    state.addChild (v, -1, getUndoManager());
    return {};
}

void CasperakiSamplerPlugin::removeSound (int index)
{
    state.removeChild (index, getUndoManager());

    const juce::ScopedLock sl (lock);
    playingNotes.clear();
    highlightedNotes.clear();
}

void CasperakiSamplerPlugin::setSoundParams (int index, int keyNote, int minNote, int maxNote)
{
    auto um = getUndoManager();

    auto v = getSound (index);
    v.setProperty (IDs::keyNote, juce::jlimit (0, 127, keyNote), um);
    v.setProperty (IDs::minNote, juce::jlimit (0, 127, std::min (minNote, maxNote)), um);
    v.setProperty (IDs::maxNote, juce::jlimit (0, 127, std::max (minNote, maxNote)), um);
}

void CasperakiSamplerPlugin::setSoundGains (int index, float gainDb, float pan)
{
    auto um = getUndoManager();

    auto v = getSound (index);
    v.setProperty (IDs::gainDb, juce::jlimit (-48.0f, 48.0f, gainDb), um);
    v.setProperty (IDs::pan,    juce::jlimit (-1.0f,  1.0f,  pan), um);
}

void CasperakiSamplerPlugin::setSoundExcerpt (int index, double start, double length)
{
    auto um = getUndoManager();

    auto v = getSound (index);
    v.setProperty (IDs::startTime, start, um);
    v.setProperty (IDs::length, length, um);
}

void CasperakiSamplerPlugin::setSoundOpenEnded (int index, bool b)
{
    auto um = getUndoManager();

    auto v = getSound (index);
    v.setProperty (IDs::openEnded, b, um);
}

void CasperakiSamplerPlugin::setSoundMedia (int index, const juce::String& source)
{
    auto v = getSound (index);
    v.setProperty (IDs::source, source, getUndoManager());
    triggerAsyncUpdate();
}

juce::ValueTree CasperakiSamplerPlugin::getSound (int soundIndex) const
{
    int index = 0;

    for (auto v : state)
        if (v.hasType (IDs::SOUND))
            if (index++ == soundIndex)
                return v;

    return {};
}

//==============================================================================
juce::Array<Exportable::ReferencedItem> CasperakiSamplerPlugin::getReferencedItems()
{
    juce::Array<ReferencedItem> results;

    // must be careful to generate this list in the right order..
    for (int i = 0; i < getNumSounds(); ++i)
    {
        auto v = getSound (i);

        Exportable::ReferencedItem ref;
        ref.itemID = ProjectItemID::fromProperty (v, IDs::source);
        ref.firstTimeUsed = v[IDs::startTime];
        ref.lengthUsed = v[IDs::length];
        results.add (ref);
    }

    return results;
}

void CasperakiSamplerPlugin::reassignReferencedItem (const ReferencedItem& item, ProjectItemID newID, double newStartTime)
{
    auto index = getReferencedItems().indexOf (item);

    if (index >= 0)
    {
        auto um = getUndoManager();

        auto v = getSound (index);
        v.setProperty (IDs::source, newID.toString(), um);
        v.setProperty (IDs::startTime, static_cast<double> (v[IDs::startTime]) - newStartTime, um);
    }
    else
    {
        jassertfalse;
    }
}

void CasperakiSamplerPlugin::sourceMediaChanged()
{
    const juce::ScopedLock sl (lock);

    for (auto s : soundList)
        s->refreshFile();
}

void CasperakiSamplerPlugin::restorePluginStateFromValueTree (const juce::ValueTree& v)
{
    copyValueTree (state, v, getUndoManager());
}

//==============================================================================
CasperakiSamplerPlugin::SamplerSound::SamplerSound (CasperakiSamplerPlugin& sf,
                                           const juce::String& source_,
                                           const juce::String& name_,
                                           const double startTime_,
                                           const double length_,
                                           const float gainDb_)
    : owner (sf),
      source (source_),
      name (name_),
      gainDb (juce::jlimit (-48.0f, 48.0f, gainDb_)),
      startTime (startTime_),
      length (length_),
      audioFile (owner.edit.engine, SourceFileReference::findFileFromString (owner.edit, source))
{
    setExcerpt (startTime_, length_);

    keyNote = audioFile.getInfo().loopInfo.getRootNote();

    if (keyNote < 0)
        keyNote = 72;

    maxNote = keyNote + 24;
    minNote = keyNote - 24;
}

void CasperakiSamplerPlugin::SamplerSound::setExcerpt(double startTime_, double length_)
{
    CRASH_TRACER

    if (!audioFile.isValid())
    {
        audioFile = AudioFile(owner.edit.engine, SourceFileReference::findFileFromString(owner.edit, source));

#if JUCE_DEBUG
        if (!audioFile.isValid() && ProjectItemID(source).isValid())
            DBG("Failed to find media: " << source);
#endif
    }

    if (audioFile.isValid())
    {
        const double minLength = 32.0 / audioFile.getSampleRate();

        startTime = juce::jlimit(0.0, audioFile.getLength() - minLength, startTime_);

        if (length_ > 0)
            length = juce::jlimit(minLength, audioFile.getLength() - startTime, length_);
        else
            length = audioFile.getLength();

        fileStartSample = juce::roundToInt(startTime * audioFile.getSampleRate());
        fileLengthSamples = juce::roundToInt(length * audioFile.getSampleRate());

        if (auto reader = owner.engine.getAudioFileManager().cache.createReader(audioFile))
        {
            audioData.setSize(audioFile.getNumChannels(), fileLengthSamples + 32);
            audioData.clear();

            auto audioDataChannelSet = juce::AudioChannelSet::canonicalChannelSet(audioFile.getNumChannels());
            auto channelsToUse = juce::AudioChannelSet::stereo();

            int total = fileLengthSamples;
            int offset = 0;

            while (total > 0)
            {
                const int numThisTime = std::min(8192, total);
                reader->setReadPosition(fileStartSample + offset);

                if (!reader->readSamples(numThisTime, audioData, audioDataChannelSet, offset, channelsToUse, 2000))
                {
                    jassertfalse;
                    break;
                }

                offset += numThisTime;
                total -= numThisTime;
            }
        }
        else
        {
            audioData.clear();
        }
    }
    else
    {
        audioFile = AudioFile(owner.edit.engine);
    }
}


void CasperakiSamplerPlugin::SamplerSound::refreshFile()
{
    audioFile = AudioFile (owner.edit.engine);
    setExcerpt (startTime, length);
}

}} // namespace tracktion { inline namespace engine
