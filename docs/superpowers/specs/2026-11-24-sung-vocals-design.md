# Sung vocals (SoulX-Singer on the Vocal track) — design

> **Removed 2026-11-24 (owner's decision).** SoulX-Singer and the singing machinery built on it (takes, the Vocals switch, singing while playing, the song's `vocals` setting) are gone; sung vocals will come from ACE-Step instead. Kept: the audio-clip lowering (`packages/engine-adapter/src/audio-clips.ts`) and the brain's serving of take files, for ACE-Step. This document is history.

Date: 2026-11-24. Status: built and live 2026-11-24 (plan docs/superpowers/plans/2026-11-24-sung-vocals.md). Calls marked "my call"; deviations found while building are in the plan's ledger rulings (voice octaves by prompt range: female voices sing as written, male an octave down; takes at -17 LUFS, about 3 dB under the band).

## Revision (2026-11-24, owner's decision after first use)

Takes are no longer recorded on the song. The brain finds a section's take by its fingerprint whenever the song goes
to the engine (play, mixer, export, render), so takes survive a refresh without saving and are never refused: a
section without a take plays no vocal and is greyed on the Vocal track. The song's vocals setting keeps the voice and
take numbers; `enabled` now means "Play first sings the grey sections" (existing takes play either way). Takes are
stored as Ogg Vorbis (about 0.25 MB a section). Clean-up, no grace period: when a saved song is saved again or
deleted, the takes its old version used that no saved song plays any more are deleted
(`apps/brain/scripts/list-vocal-takes.ts --delete-unused` clears takes of songs never saved). Sections below that
mention recording takes in `aiArtifacts` and refusing playback (409) describe the first version.

## Intent

Today a song's Vocal track has notes and lyrics but makes no sound: the engine does not play it. The owner wants to
hear someone sing the song, at good quality, for the whole song or section by section, with the same takes in the
editor, the export and the music video. Singing is slow (GPU work), so it is switched on per song only when wanted.

The audio-clip lane built for this is general: later, ACE-Step tracks are added to songs the same way.

## Goals

- A **Vocals on/off** switch per song, off by default. Off: nothing is sung, playback as fast as today.
- On: each section's vocal is sung by SoulX-Singer on datigator's GPU, stored as a **take**, and played as an audio
  clip on the Vocal lane, through the mixer (volume, mute/solo, effects), mastering, the export and the video.
- A take is reused until what it was sung from changes: the section's vocal notes and lyrics, the voice, the key,
  the tempo, the model settings. Editing one section re-sings only that section.
- **Sing again**: a fresh take of one section (or the whole song) on request.
- A **voice** choice per song, from SoulX's demo voices to start.
- Best quality settings (quality over speed).

## Non-goals

- Better lyrics (the legacy lyric bank stays; a separate project).
- The owner's own singer voices (added later as voice prompts; the design leaves room).
- ACE-Step itself (only the clip lane it will reuse).
- Editing a take (pitch or timing fixes on the audio).
- The backing vocals ("Backing vocals 1" and "2"): lead only to start; they stay silent in choruses and bridges as
  today. A second step, once the lead has been heard (the owner's decision, 2026-11-24).

## Anti-goals

- Slowing anything down while Vocals is off.
- Silent failure: if singing fails, the song must not play quietly without the vocal as if all were well. The error
  is shown; playing without the vocal is the user's explicit choice.

## Approaches considered

1. **The vocal as audio clips inside the engine (chosen).** SoulX sings each section; the brain places each take as
   an audio clip on the Vocal lane, the way loops and transition sounds are placed. Gets the mixer, effects,
   mastering, export and video for free; per-section takes; reusable for ACE-Step. Cost: a new or changed section
   must be sung before it plays; needs datigator's GPU.
2. A separate vocal file playing beside the engine (`docs/41` "AI artifact"). Less work at first, but fragile sync
   (seek, loop) and no mixer, effects or export mixing.
3. Vocals only at export. Simplest, but the singing is never heard while working.

The owner chose 1 ("we'll need this anyway once ACE-Step tracks can be added").

## What exists

- **SoulX-Singer** (Apache 2.0) on datigator: weights `/mnt/d/casperaki-models/Soul-AILab__SoulX-Singer/model.pt`,
  repo and venv under `apps/models/services/soulx-singer`, a harness adapter
  `apps/models/services/_serving/adapters/soulx-singer.py`, and the hum-training batch worker
  `apps/models/hum-beats/soulx/worker.py` (one model in memory, about 3 s per clip at 16 steps). Input per segment:
  phonemes per note (English as `en_K-IH0-NG`), durations in seconds, MIDI pitch per note, note type (1 rest, 2
  note, 3 slur), and a voice prompt (a short sung clip with its own metadata). `control="score"` sings the MIDI
  notes (no pitch curve needed).
- **Lyrics on every vocal note**: `vocalNote` events carry `fullWord` ("Wal-", "King") and `vocaloidPhonemes` in
  ARPAbet (`[k ih0 ng]`), and `endOfPhrase`; written by the lyric bank (`packages/arrangement/src/vocals/scaffolding.ts`).
  ARPAbet maps one to one onto SoulX's English phonemes.
- **Wave clips in the engine** (`apps/web/wasm/engine`, which builds both the browser player and the server's
  `casperaki_render`): `Clip{type:"wave", startSec, endSec, source, loop}`; percussion loops (looping, one per
  section) and transition samples (one-shot) use them; the brain's playback plan serves them as `wave` samples.
- The Vocal instrument is not lowered to the engine today (`packages/engine-adapter`), so it is silent.

## Design

### 1. The singing service (svc-soulx)

A harness service on datigator like svc-hum and svc-amt (port 16512, `SOULX_SERVICE_URL` in brain.env), one model
in GPU memory. One route: **sing** a list of phrases with one voice → one WAV per phrase. Quality settings fixed in
the service (diffusion steps at least the model's default; the hum work's 16 was for speed). Fails loudly (a phrase
it cannot sing is an error naming it).

It shares the GPU with hum-to-song and AMT; it is added to datigator's service start-up the same way they are.

### 2. From a section's vocal notes to a SoulX score (brain)

For each section with vocal notes: the notes in order, at sung MIDI pitch, timed by the song tempo, with their
phonemes (ARPAbet → `en_…`) and rests as `<SP>`. A note without phonemes is an error naming the section and bar (the
lyric bank always supplies them).

*Phrases (my call):* `endOfPhrase` marks the last note of every bar (a legacy invariant), not a lyric line, so it is
not the split point. A SoulX call is a lyric line (the lyric bank writes one line per 4 bars), split earlier only at
a real rest of a beat or more, so legato lines are sung whole with context. The builder confirms SoulX sings a
4-bar line well; if not, the split moves to the nearest rest.

*Slurs (my call):* none for now. The lyric bank gives every note its own syllable (it reuses a line's syllables when
a line has more notes than syllables), so there is no held-syllable marker to read. Every note is sung as a note
(type 2).

*Pitch (my call):* the take sings the written notes. A voice may carry a fixed octave (stored with the voice: a
female voice sings the line an octave up); the score, the MIDI export and the video keep the written notes, as
any song does when a woman sings a part written in the tenor range. Each voice in the catalogue has its comfortable
range and octave.

### 3. Takes

A take is one WAV per section, as long as the section, the phrases placed at their times, silence between. Its
**fingerprint** covers: the section's score (notes, phonemes, timing in seconds), the voice, the model settings and a
take number (Sing again increments it). Takes are stored on datigator outside the repo (with the other data), named
by fingerprint, loudness-normalised like the sample library, and kept until the owner clears them (never deleted
silently).

### 4. The song

A per-song vocals setting in the song: on/off, voice, and per section the take number (for Sing again).

*Takes in the song (my call):* each take in use is recorded in the song's existing `aiArtifacts` field (kind
`soulx-vocal`, attached to its section and instrument, with its file, checksum, loudness, model and voice). So a song
names the exact audio it plays, the export and video read it from there, and a copied song keeps its takes. The
fingerprint decides whether a recorded take is still current.

When on, the brain lowers the Vocal track to an **audio-clip lane**: per section, one clip at the section start with that
section's take as its source. The lane is general (an instrument whose clips name their own audio file), so ACE-Step
tracks can use it later. When off, the Vocal track stays unlowered (silent, as today).

### 5. Engine

One addition to the engine (both builds): the audio-clip lane, each clip one-shot with its own source file, start
and length, mixed on its own lane (mute/solo, volume, effects, mastering like any lane). The playback plan serves the
take files as wave samples.

### 6. Web

- **Vocals** switch and **voice** picker on the song (editor header).
- With Vocals on, Play first asks the brain which sections lack a current take; those are sung (progress: "Singing
  chorus 2 of 6"), then the song plays. Singing errors are shown; "Play without vocals" is offered as a button.
- **Sing again** on a section (and for the whole song).
- The export and video use the same takes (singing first if any are missing).

### 7. Access and clean-up (my call)

There is no admin distinction yet ("permissions later"), so every signed-in user may switch Vocals on. The service
sings one request at a time (a queue), so users wait in turn rather than overload the GPU. Takes are cleared by hand
for now: a script lists them by song and size and deletes only what the owner names; a clear-takes control comes
with permissions.

## Left to the builder

- SoulX phrase length, steps and sample rate; the service's batching.
- Which demo voices to offer (female and male, the lowered prompts from the hum work included) and their names.
- The take store's exact place and the fingerprint's exact contents.
- The default vocal effects on the lane (a little reverb and compression), via the mix config.
- Notes that start before a section (pickups): placed in the section whose bars hold them.

## Owner's decisions so far

- Approach 1, audio clips (2026-11-24).
- Whole song or section by section; quality matters.
- Vocals off by default, a switch per song.
- Start with SoulX's demo voices; own voices later.
- Keep the legacy lyrics for now.
- Lead vocal only to start; backing vocals later.
