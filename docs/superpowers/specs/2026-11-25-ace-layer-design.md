# ACE layer: add one instrument part to a song with ACE-Step lego

Approved by the owner 2026-11-25 ("Yes, that works well. Please go ahead.").

## Why

Add flavour to a finished song without rewriting it: one extra part (a guitar, strings, brass …) played by ACE-Step
over the song as it is, for the whole song or only a selection.

## What the spike showed (2026-11-25, apps/models/ace-vocal-tests/layer-spike, outputs /mnt/d/casperaki-models/ace-layer-tests)

- ACE-Step 1.5 **base** model (`acestep-v15-base`, `dcw_enabled=False`), task `lego`, `src_audio` = our full mix,
  instruction "Generate the GUITAR track based on the audio context:", lyrics "[Instrumental]", instrumental, the
  song's bpm and key, 50 steps, guidance 7.0, shift 3.0, ode, cover strength 1.0.
- Guitar and strings come back as **the part alone** (waveform correlation with the source 0.00, no bass), in time
  (onsets within ±30 ms of the source grid), about 7 dB under the mix. Percussion partly copies our drums: left out.
- About 3 s per 45 s of audio after a 28 s model load; 8 GB of GPU memory.
- Time-range (repaint) mode returns the source outside the range and replaces it inside: not a layer. A selection is
  therefore done by generating over the whole song and keeping only the selected stretch.

## What the user sees

- **Add ACE layer…** on the timeline's right-click menu and on the selection's menu.
- A dialog: the instrument (guitar, strings, brass, woodwinds, keyboard, synth, fx, backing vocals), optional style
  words, and what it covers: "the whole song" or, with a selection, "bars X–Y (the selection)".
- A background task on the Tasks page with its steps (render, ACE, cut, store) and Cancel, as Sing's.
- When ready, it goes in when playback stops (hourglass): an audio-only track named "ACE <Instrument>" ("ACE Guitar",
  a second one "ACE Guitar 2"), one clip per section it covers, mutable and deletable like Ad-libs.
- A section's clip drops out when that section's bars, chords or the tempo change later (as sung takes do).

## How it works

1. **Brain task `aceLayer`** (options: instrument, caption, optional bar range) — one at a time per kind.
2. **Render**: the song's mix as it is now (the brain's existing render path), as WAV.
3. **svc-ace** (new adapter `ace-layer` on the serving harness, own port, started at boot): loads the base model once;
   a job runs lego over the whole render with the spike's parameters, caption = the instrument's default description
   plus the user's words plus the song's bpm and key; returns the part as WAV. Steps reported like svc-vocals.
4. **Cut**: per section the layer covers, the part from the section's start to its end; with a selection, silence
   outside the selected bars (so a clip may start with silence). Stored as OGG in the takes directory.
5. **Result → apply**: one AI artifact per section, kind `ace-step-conditioned`, attached to the section and the
   track, with a fingerprint of the section (as sung takes). The lowering plays them as an audio-clip lane (dry sends).

## Left to the builder

The mix type of the clip lane and its level, the dialog's look, the step names, the service port.
