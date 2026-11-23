# Hum to song: design

Date: 2026-11-23. Status: agreed with the owner in conversation; parts are still being measured.

## Intent

The user hums (or sings) a short melody, and Casperaki turns it into a song: the hum becomes the chorus melody, and
the brain builds the rest of the song from it as it does for any vocal precedent.

## Flow

1. **Record.** The user picks one of two modes:
   - **With a click (main mode):** the user sets a tempo and hears a count-in, with a visual 1, 2, 3, 4, then hums
     along. Tempo and beat 1 are known, so only the notes have to be found.
   - **Without a click:** the user hums freely. The tempo and bar lines are detected, and there is a **Retry** button.
2. **Beats** (free mode only): the fine-tuned Beat This! checkpoint (`apps/models/hum-beats`, run
   `beatthis-hum-20261123-1045`) with DBN post-processing, assuming 4-beat bars (owner decision). The bar phase comes
   from the downbeat activations.
3. **Notes:** SwiftF0 pitch, then a correction for how far the recording is out of tune overall, then snapping to the
   estimated key (`apps/models/hum-pitch`, step 1). A trained curve-to-notes model, now in training, may replace the
   rule-based step once it beats it. The key is estimated from the hum. Notes are snapped to the beat grid in 8ths by
   default.
4. **Length:** the hum is fitted into 2, 4 or 8 bars.
5. **Harmony:** a chord per bar or half bar for all 8 bars (`apps/models/chord-fit`). Each chord is scored by how well
   it covers the melody, and a chord-to-chord prior learned from the precedents and the chord bank picks the best
   sequence. A known progression is preferred when it fits nearly as well. The user gets two or three alternatives to
   listen to and pick from.
6. **Complete the melody** to 8 bars with the Anticipatory Music Transformer (owner's choice). It fills in the
   missing bars around the hummed ones, conditioned on the chosen chords (`apps/models/amt-spike`, being evaluated;
   the licence must be checked first).
7. **Hand-off:** the result becomes a vocal precedent `{properties, melody, chords}`, and the brain's existing
   pipeline (arrangement, sounds, sections) builds the song. After that, the editor and the song assistant correct
   any notes.

## Measured so far (HumTrans test, real hums)

- **Beat tracker:**
  - fine-tuned checkpoint plus DBN: beat F 0.71 (final0: 0.53), right tempo on 84% of clips;
  - with 4-beat bars, 27% of 4/4 clips have at least 90% of notes in position at 16ths (73% of notes at 8ths).
- **Free humming is limited by beats and notes equally.** That is why click mode is the main mode.
- **Notes:** SwiftF0 plus tuning correction plus key snapping gets 71% of notes right; plain SwiftF0 gets 66%, and
  Basic Pitch 55%.

## Decisions

- 2026-11-23: the owner accepts training on the HumTrans-derived round-two data (the HumTrans recordings themselves stay
  evaluation only).
- 4-beat bars are assumed.
- The main recording mode is a click with a count-in; free humming has a retry.
- The melody is completed by the Anticipatory Music Transformer, hosted on datigator.

## Open decisions (owner)

- Switching the hum lab to the new beat checkpoint.
- Deleting about 22 GB of old hum-beats data.

## Goals and non-goals

- **Goal:** about 90% of hums give a melody the user recognises, with notes in the right place, at least in click
  mode.
- **Non-goal:** perfect free-tempo transcription. Instead, rely on retry and on easy correction in the editor.
- **Anti-goal:** a result that loses the user's motif. The completion must reuse and vary the hummed material.
