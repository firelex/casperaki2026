# 67 — Renderer parity audit: new engine vs legacy JUCE/Tracktion (2026-11-22)

The new renderer (`apps/web/wasm/engine`, one C++ codebase built to WASM for the
browser and natively as `casperaki_render` for server export) sounds good but not
like, nor as good as, the legacy `casperaki_engine` (JUCE + Tracktion). This audit
lists what the port missed or does differently. **Goal: adapt the new engine to do
what the old one did.**

Legacy reference = `casperaki_engine` at commit `90dc0f4` (before the in-tree FX
rewrite). Tracktion source: `casperaki_engine/dependencies/tracktion_engine`.
Short names: **LEG** = legacy `Source/`, **TE** = Tracktion `modules/tracktion_engine`,
**NEW** = `apps/web/wasm/engine/src`.

Status column: `verified` = checked in code by the lead session; `reported` = from an
audit sub-agent, not yet independently checked.

## Ranked findings

| # | Finding | Status | Impact |
|---|---|---|---|
| 1 | No mastering stage (+5 dB → NC-17) | verified | high |
| 2 | Loops repeat at file length, not whole bars → drift | verified | high (loop genres) |
| 3 | EDMArpeggiator lead lane silent | verified | high (brightPop/edm/schlager) |
| 4 | Drum hits ~4.9 dB too loud (channel velocity 96 missing) | verified | high |
| 5 | Guitar strums cut at note end (legacy open-ended) | verified | high (guitar songs) |
| 6 | Aux returns go through master rack (legacy bypassed it) | verified | medium–high |
| 7 | Notes not cut at clip/segment end | reported (2 agents agree) | medium |
| 8 | Same-pitch retrigger not cut; stray note-off kills newer note | reported (2 agents agree) | medium |
| 9 | Browser live path adds a DynamicsCompressor the export lacks | reported | medium (live only) |
| 10 | TransitionPattern (EDM snare roll) silent | reported | depends on catalog rows |
| 11 | Outro fadeOut direction differs from legacy — **keep new (owner)** | decided | — |
| 12 | Possible ~25 ms MP3 encoder-delay offset in sample slices | unverified | unknown |
| 13 | 16-bit undithered WAV; CBR 192k vs lame -V2 | reported | low |
| 14 | Minor: LowPass open clamp, automation on absent lanes, ending tail | reported | low |

Two more from the mix-graph audit:

| # | Finding | Status | Impact |
|---|---|---|---|
| 15 | `edmSnareDrumRoll` −12 dB track trim missing (and adapter names it `edmSnareDrumRoll__<seg>`, so an exact-name check would miss) | reported | with #10 |
| 16 | FreqShiftEcho wet trim (−14 dB) was tuned by ear under the wrong return routing (#6) — re-tune after #6 | reported | medium |

**Open question — which legacy build is "the original"?** `JUCE_PLUGINHOST_VST=1` is
only on the Windows (VS2022) exporters; Mac/Android/LinuxApp/LibWASM builds disable it
and ran the `#else` Tracktion-builtin rack chain (compressor/4bandEq/reverb/delay/chorus)
— a different sound. The new engine ports the Windows/AirWindows `#if` chain. The
production server (casperaki2-engine-js calling the InstrumentalGenerator binary) appears
to have been a Windows build. **Owner (2026-11-22): the original ran on Windows on the old
JUCE engine (completed ~2023–24) → the AirWindows `#if` chain is the target; keep our
in-tree stand-ins (FreqShiftEcho for Valhalla, SimpleSide rebuild).**

Mix graph checked and equivalent: all 15 rack chains' decoded params == mix-config.json;
racks are serial stereo, all plugins enabled, dry/wet 0/1; Tracktion AirWindows wrapper
pushes saved params every block; track chain Sampler → LowPass → target vol → fader
(automation) → meter → post-fader sends matches; linear pan, centre = unity; no plugin
reports latency in either engine.

### 1. No mastering stage
- LEG: production always called `--generate_mastered_song_from_json`
  (`InstrumentalGenerator/Main.cpp:68,298,359`; `casperaki2-engine-js/api/v1.0/controllers/songs.js:302,475`).
  `InstrumentalGenerator.h:81` → `masterSongAtemlos(..., shouldLimit=true)` →
  `JUST_BOOST_AND_LIMIT` (`dependencies/matchering/Source/Matchering.h:1705-1716`):
  `applyGain(+5 dB)` then `Casperaki_NC17` with `setParams(0.0, 0.89)` (AirWindows
  NC-17: two-band soft saturation + 2nd-harmonic). No reference EQ/RMS matching on
  this path; `referenceAtemlos.wav` and `isVibe` are unused. Then `lame -V2`.
- NEW: `audio/Render.h:128` peak-normalises to 0.9 (≈ +0.2 dB). No boost, no NC-17.
  `engine-spike/native/matchering_postprocess.*` is not used in production.
- Fix: port +5 dB → NC-17(0, 0.89) into the engine after the master stage (replace
  peak-normalise) so live and export share it. NC-17 is already vendored
  (`audio/airwindows/NC17.aw.cpp`; legacy `Casperaki_NC17.h` for exact params).

### 2. Loop period
- LEG `instruments/Loop.h:58-67`: loop range = `4 * bars` beats, where `bars` = file
  length in bars at song tempo, rounded down; tail of the file is dropped.
  `setLoopRangeBeats` also turns auto-tempo on (SoundTouch at ratio ≈1 — possible
  slight transient colouring, uncertain).
- NEW `audio/Mixer.h:550`: `rel % data->frames` (whole decoded file). Files carry
  MP3 padding (+31 ms on a 1-bar 99 bpm loop) → cumulative drift, ~220 ms after 8 repeats.
- Fix: loop period = floor(file bars at tempo) × 4 beats, in samples.

### 3. EDMArpeggiator silent
- Brain emits it (`packages/arrangement/src/patterns/synths.ts:91-96,162`); LEG
  expands it (`instruments/TonalInstrument.h` → `SequencerUtils.h:343-599`
  `getEDMArpeggiatorNotes`). NEW skips it (`Tonal.h:213`, `Guitar.h:247`).
- Fix: port `getEDMArpeggiatorNotes`. Also validate the ported-but-unexercised
  `arpeggio` path (`Tonal.h:170`).

### 4. Drum velocity
- LEG: `Drums.h:292-298` `insertNewChannel` → channel velocity default 96
  (`TE/model/clips/tracktion_StepClip.h:178`); note-on = step vel × 96/127
  (`tracktion_StepClip.cpp:389-393`) → sampler gain −20·(1−0.756) = −4.9 dB.
- NEW: `Resolver.h:558` hit = 127 → 0 dB (`Mixer.h:1033`).
- Fix: scale step hits by 96/127 (also TransitionPattern grids). Check first that
  mix-config drum levels were not later tuned to compensate.

### 5. Guitar strums
- LEG `instruments/Guitar.h:362` `setSoundOpenEnded(index, true)`.
- NEW `audio/Mixer.h:1191` `openEnded = false` (via `buildPerNoteSampler`, `:1100`).
- Fix: open-ended for the strum sampler.

### 6. Return routing
- LEG `sequencer/Sequencer.cpp:221-225`: send/return tracks are inserted but never
  routed to the "MASTER" rack track, so they go straight to the edit master (−1 dB
  only), bypassing Console8BussIn → Logical4 → Console8BussOut → ADClip7.
  (Un-routed `sampleTransitionsTrackPercussion` probably bypasses it too — check.)
- NEW `audio/MixGraph.h:205-208` sums returns into `master_` before the master rack.
- Fix: sum returns after the master rack, before the −1 dB master volume.

### 7–8. Voice boundaries (stock `te::SamplerPlugin`, `LEG/config.h:24 USE_TE_SAMPLER`)
- Clip end: TE sends note-offs at clip/loop end (`TE/midi/tracktion_MidiList.cpp:841`,
  `tracktion_LoopingMidiNode.cpp:1365-1390`). NEW schedules note-off at full note
  length (`Mixer.h:984-991`) → sustain tails ring 2 beats into the next segment.
- Retrigger: TE cuts a non-open-ended voice of the same pitch on note-on
  (`tracktion_SamplerPlugin.cpp:311-320`) and drops overlapped note-offs
  (`tracktion_MidiList.cpp:1966-1985`). NEW `Sampler.h:258-271` never cuts;
  `noteOff` (`:304-310`) kills every voice of that pitch, including the newer note.
- Fix: clamp note-offs to clip end; on note-on stop same-pitch non-open-ended voices;
  drop note-offs of overlapped same-pitch notes.

### 9. Live compressor
- `apps/web/.../livePlayer.ts:736-742` adds a DynamicsCompressorNode (−3 dB, ratio 20)
  the server export doesn't have. Remove once the engine has the mastering stage (#1).

### 10. TransitionPattern
- Adapter emits `type: 'transitionPattern'` (`packages/engine-adapter/src/index.ts:1360-1390`);
  NEW `Resolver.h:85-90` routes it to `resolveTonalInstrument`, which returns (`:297`).
  LEG plays it as a step clip (`instruments/TransitionPattern.h:58-95`). Check whether
  the catalog has `snareDrumsElectronic` rows.

### 11. Outro fadeOut
- LEG `Instrument.cpp:85-101` replaces the last point with the track default, so the
  legacy "fade-out" (−10 → −25 from `EffectsClass.js:130-141`) dipped and came back.
  NEW `packages/engine-adapter/src/signal-processors.ts:46-51,110-121` is a real fade.
  **Owner decision 2026-11-22: keep the real fade-out (no change).**

### 12–14. Smaller
- Sample slices: NEW decodes the preset MP3 via ffmpeg and cuts at `sliceStart/End`
  (`SampleLibrary.h:411-448`); LEG used server-cut `vstsample-<id>.ogg`. Possible
  25 ms encoder-delay offset — check by cross-correlating one slot.
- Output: NEW 16-bit WAV, no dither (`main_render.cpp:135-138`), CBR 192k
  (`apps/brain/src/render/renderService.ts:173`); LEG 24-bit render, lame -V2.
- LowPass: LEG freq range clamps to 22 kHz and the filter stays inserted; NEW bypasses
  ≥ 0.49·sr (`LowPass.h:21`). Automation on lanes absent in a segment: LEG skips
  (`Sequencer.cpp:433-436`), NEW doesn't (`Resolver.h:172-200`). Ending: LEG cuts at
  edit length, NEW adds 2.5 s tail (keep).

## Checked and equivalent
Interpolation (4-point Lagrange), pitch ratio, linear pan law, velocity law
`gainDb − 20·(1−vel)`, 30-sample fade-in / stop fades, 32 voices, zone mapping,
no velocity layers/round robin, velocity ladder 0.9/0.7/0.5/0.3, guitar random
velocity order, strum offsets, no groove/quantise, drum grid/fills, transition
placement, clip fades (0), master rack plugin order and decoded params, −1 dB master.

## Fix log (2026-11-22)

Parity measured with `scripts/validate-fx-parity.mjs` (per-⅓-octave log-spectral
distance vs the native Tracktion goldens, which route returns like legacy). Note the
goldens were rendered by the *modified* native copy, whose `Loop.h` tiles loops at file
length (docs/54o: `setLoopRangeBeats` hung `renderToFile`) — so for #2 the golden itself
carries the drift and is not the reference.

| genre | before | after #6 | after #4 | after #5/#7/#8 (+#2) |
|---|---|---|---|---|
| ballad | 1.00 | 0.63 | 0.42 | 0.047 |
| brightPop | 1.51 | 1.28 | 0.03 | 0.011 |
| edm | 1.02 | 0.89 | 0.05 | 0.05 |
| rock | 1.25 | 0.91 | 0.29 | 0.069 |
| latin | 1.15 | — | — | 0.85 (guitar random velocity + loop tiling differ from golden) |
| organicVibes | 1.46 | — | — | 0.16 |
| schlager / urban | — | — | — | 0.02 / 0.016 |

RMS now matches the goldens within 0.15 dB in every genre except latin (+0.35 dB).

- **#1 mastering** — DONE. Engine: `MixGraph::setMastering` (+5 dB → NC-17(0, 0.89),
  verified the vendored NC-17 DSP == `Casperaki_NC17.h` apart from denormal/dither noise);
  `CASPERAKI_MASTER=1` native, `mixer_set_mastering(1)` WASM; live playback uses it.
  Mix-on renders are no longer peak-normalised (legacy never normalised).
  Export (owner decision): unmastered + mastered, mastered = the legacy JUCE matchering
  port in **SERGREE** style (reference-matched to Atemlos; legacy production only ever ran
  the boost style). `casperaki_matchering_smoke <in> <out> <sergree|boost>`; brain
  `renderService` steps lower → render (24-bit `out-unmastered.wav`) → master (`out.wav`)
  → encode (LAME `-q:a 2` = `-V2`, both). Routes `render.{wav,mp3}` (mastered) and
  `render-unmastered.{wav,mp3}`; Export window + project menu offer both.
  brightPop: unmastered −14.3 LUFS; engine NC-17 −11.4 LUFS; SERGREE −9.9 LUFS but
  **+1.6 dBTP** true peak — needs a ceiling before MP3. Next: JUCE-free matchering port
  so the browser can master (and export) without the server.
- **#2 loops** — DONE (`Mixer::loopPeriodFrames`, legacy floor-bars period; throws if a real
  loop is shorter than a bar).
- **#3 EDMArpeggiator** — DONE (`Tonal.h getEDMArpeggiatorNotes`, `test/arpeggio_test.cpp`);
  also fixed plain `arpeggio` reading the int `octave` as a string (notes at MIDI 0).
- **#4 drum velocity** — DONE (`kStepChannelVelocity` = 96/127).
- **#5 strums** — DONE (strum sampler open-ended).
- **#6 return routing** — DONE (returns join after the master rack, before −1 dB).
- **#7/#8 voice boundaries** — DONE (note-offs at min(end, clip end) − 0.1 ms; overlapped
  same-pitch notes lose their note-off; note-on stops same-pitch non-open-ended voices;
  seek treats any later same-pitch event as a release).
- **#9 browser compressor** — REMOVED (engine NC-17 bounds peaks at 0.95).
- **#10/#11 snare roll** — DONE (`Resolver::resolveTransitionPatternInstrument`, roll lane in
  `Mixer.h`, `test/transition_pattern_test.cpp`): legacy placement/steps, channel velocity 96,
  target volume + the −12 dB trim on every roll lane (legacy's exact-name match on
  "edmSnareDrumRoll" misses the adapter's `edmSnareDrumRoll__<segment>` names, so the
  goldens lack the trim — edm/organicVibes/schlager LSD rose to 0.16–0.22 against them).
  Open: legacy's channel→sample order was `std::unordered_map` hash order (pattern channel 0
  played `samples[1]`); the port uses the adapter's order (channel i = `samples[i]`).
- **#12 FreqShiftEcho wet trim** — open: re-tune by ear now that #6 is fixed.
- **#13 slice offset** — CONFIRMED NOT AN ISSUE: new native/browser slices have 0-sample
  offset (slice times are REAPER grid positions; gapless decode). Legacy mp3splt cut on
  frame boundaries (−13..+46 ms, a defect — not copied). Fixed the real hazard: a failed
  ffmpeg conversion silently fell back to minimp3 (+51 ms) — now throws.
- **#14 output format** — DONE for export (24-bit WAV, LAME V2).
- **#15 low-pass** — DONE, legacy behaviour (10–22000 Hz clamp, always in circuit; also fixes
  a stale-state click when a bypassed filter re-closed).

Pre-existing, not from this work: `validate-resolution.mjs` fails all 8 genres at HEAD too
(README's "all 8 pass" is stale).
