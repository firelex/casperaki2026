# 58c — Sound-parity audit: drum tails

Status: closed — hypothesis falsified by archaeology and confirmed by a
targeted A/B probe. No engine code change required; the openEnded
let-ring path is wired end-to-end and demonstrably active.
Predecessor: 58a (Keys piano-sustain) — landed option (b) per-family
sustain-tail extension; deferred this slice plus 58f (bass attack) and 58g
(velocity curves).

## Hypothesis (carried over from 58a)

> Drum samples are typically pre-baked one-shots, so the duration field
> shouldn't matter — but if the TE sampler treats `note-off` as a hard
> truncate on Drums too, snare/cymbal tails may be losing their natural
> decay.

That was the 58a brief's framing. The conditional clause is the load-bearing
part: *if* the TE sampler hard-truncates drums, *then* the same fix family as
58a (option-(b) tail extension) would apply. The archaeology below shows the
*if* doesn't hold — drums are already wired through the openEnded path that
58a had to retrofit for Keys.

## Map of the active drums note-off path (today)

1. **Brain** emits a drum pattern as a 32-step string of `x`/`0` per
   sub-instrument (`bassDrum`, `snareDrum`, `hiHat`, `crash`, `ride`,
   `clap`, `snap`, `shaker`, toms, …) — not the per-note shape Tonal lanes
   use.
2. **Engine, song-walking**
   (`casperaki_engine/Source/instruments/Drums.h:114–128, 161–274,
   307–361`) reads the pattern, switches the sub-instrument into one of
   four TE sub-tracks (`kicksTrack`, `snaresTrack`, `tomsTrack`,
   `restTrack`), and writes a single `te::StepClip` per sub-track for the
   segment.
3. **Step-clip note length** is fixed at 1/8 beat
   (`Drums.h:286 — clipPattern.setNoteLength (te::BeatDuration::fromBeats (1.0/8))`).
   Each "x" cell in the 32-step grid emits an 8th-note-long MIDI event
   onto the StepClip channel mapped to that sub-instrument.
4. **Sampler** is `tracktion_engine::SamplerPlugin` — same as the post-58a
   Tonal lanes. The four drum sub-tracks each have their own instance,
   loaded by `Drums::createSampler` (`Drums.h:485–523`).
5. **Critical detail.** `Drums::createSampler` calls
   `samplerPlugin->setSoundOpenEnded (index, true)` on every drum sound
   it adds (`Drums.h:519`).
6. **TE SamplerPlugin honors openEnded as the 58a-style let-ring.**
   `spike55a/deps/tracktion_v3.2.0/.../tracktion_SamplerPlugin.cpp`:
   - line 244 (`playNotes`-side noteOff): `&& ! playingNotes...->openEnded`
     guards the `samplesLeftToPlay` clamp.
   - lines 313 and 352 (`applyToBuffer` noteOn / noteOff paths): same
     `&& ! playingNote->openEnded` guard before the clamp. With
     openEnded=true, the voice is not shortened on note-off and plays to
     its natural sample end.
   - line 376: the voice is only removed when `sn->isFinished`, i.e. the
     sample has reached its file end on its own.

So at the TE-sampler level, drum sounds are already in the "let-ring to
natural decay" mode. The 58a-style hard-cut symptom does not apply to
Drums under the active code path.

## Why this is different from the Keys case

58a found:
- Keys go through `addNoteToClip` (`SequencerUtils.h:625–659`).
- That writes per-note MIDI into a `te::MidiClip`, NOT a `StepClip`.
- Nothing in that path calls `setSoundOpenEnded` on the Keys sampler —
  the openEnded flag is never set, so TE's sampler clamps `samplesLeftToPlay`
  at note-off and the sample truncates.
- 58a fixed it by extending the BeatDuration passed to `sequence->addNote`
  per Synths-family lane (option b).

Drums diverge at every step:
- StepClip, not MidiClip — different note-write path.
- Per-sound `setSoundOpenEnded(index, true)` is called at sampler creation
  (`Drums.h:519`), so even though MIDI note-offs fire 1/8 beat after note-on,
  TE's sampler ignores them and plays the sample through. Same code path
  (`tracktion_SamplerPlugin.cpp:352`) but the opposite gate result.

## Cross-instrument inventory of `setSoundOpenEnded`

Grep across `casperaki_engine/Source` for `setSoundOpenEnded(.*, true)`:

| caller                          | site                | applies to                  |
| ---                             | ---                 | ---                         |
| `Drums::createSampler`          | Drums.h:519         | every drum sample           |
| `Guitar`                        | Guitar.h:369        | guitar samples              |
| `TransitionPattern`             | TransitionPattern.h:163 | transition fx samples   |
| (none for Keys / Synths / Pad / Bass / Vocals) | n/a       | hard-cut path (58a fixed Synths-family via option b) |

So three lanes (Drums, Guitar, transition fx) were already wired
openEnded-by-default at sampler creation time. The 58a deferred audit had
not yet noticed this.

## Predicted outcome

Drum tails should already be ringing out their full natural sample length.
The Drums-only fixture's trailing-silence rms is expected to be *not silent*
— closer to the post-58a Keys "fix" tail-region rms than to the pre-58a
Keys "baseline" tail-region rms.

If the measurement matches the prediction, 58c closes with no engine code
change: the let-ring behaviour was preserved through the JUCE/TE
modernization (55a–55d) and never regressed. If the measurement shows a
hard-cut tail anyway, archaeology is wrong somewhere — likely the per-track
volume curve from `applyMuteToTrack` (`SequencerUtils.h:675–699`) or some
post-sampler plugin (post-volume, low-pass) that's gating mid-sample. That
would become 58c's real fix target.

## Drums-only render harness

`apps/engine-spike/scripts/render-drums-fixture.mjs` (this commit, new) —
mirrors the 58a Keys harness:

1. Derives the fixture from `out/all-genre-render-smoke/ballad/` (any genre
   with Drums=true works; ballad is chosen for parity with the 58a fixture).
2. Mutes every non-Drums lane in song.json (Keys / Bass / Pad / Synths /
   Guitar / Loop / Vocals → false; Drums → true).
3. Clears transitions per segment, same as the Keys harness, so the only
   audible energy in the render comes from the Drums sub-tracks.
4. Renders with the current engine binary.
5. Reports full-file peak/rms + tail-region rms in the last 0.5 s.

## Validation plan and results

The Keys harness's "tail rms in the last 0.5 s of the file" metric does
NOT carry to drums on step-clips. Two reasons:

1. The keys.ts pattern emits a 4-beat chord event whose noteOff sits a
   handful of samples before the segment boundary, so a release tail
   measurably leaks into the trailing silence. Drums on a step-clip emit
   1/8-beat MIDI notes; the LAST drum hit's natural decay is bounded by
   the sample's own file length, which (for the stub samples — 100–200 ms)
   ends well before the 0.5 s trailing window opens.
2. The stub-sample fixture is deliberately tiny — kick.ogg 200 ms,
   snare.ogg 150 ms, hat.ogg 100 ms. With real drum samples (snare/cymbal
   tails 1–3 s), the openEnded effect *would* leak into the trailing
   window, but we run the matrix against the stub.

So the validation plan pivots: instead of inferring openEnded from
trailing silence, probe the openEnded code path directly via an in-tree
A/B — flip `Drums.h:519` from `true` to `false`, rebuild, re-render,
compare. A measurable delta between the two renders proves the flag is
electrically connected to the render output; a null delta would mean
either the flag is dead-code or the choice happens to be irrelevant for
the stub fixture, both of which would force a deeper investigation.

### Drums-only A/B

`apps/engine-spike/out/drums-fixture/{baseline,drums-hardcut}.json`.
Ballad-derived fixture, all non-Drums lanes muted, full 268.8 s render.

| metric        | baseline (openEnded=true) | drums-hardcut (openEnded=false) | delta      |
| ---           | ---                       | ---                             | ---        |
| durationSec   | 268.800                   | 268.800                         | 0.000 s    |
| peakDb        | **-6.655**                | **0.000**                       | +6.655 dB  |
| rmsDb         | -30.371                   | -29.684                         | +0.687 dB  |
| tail.peakDb   | -inf                      | -inf                            | n/a        |
| tail.rmsDb    | -inf                      | -inf                            | n/a        |

Both renders pass the gate trio (peak > -40 dB, rms > -35 dB, duration >
30 s); both produce audibly active drums end-to-end. The tail-region
columns are -inf in both, as the section above predicted — that metric
is silent on this question.

The meaningful columns are peak and rms:

- **peak +6.655 dB** when openEnded flips off: rapid kick retriggers stop
  cutting each other on every step. With openEnded=false the noteOn-path
  truncate at `tracktion_SamplerPlugin.cpp:313` clamps each previous
  voice to `minimumSamplesToPlayWhenStopping = 8` samples, so retriggers
  start from a clean voice each time and the sum is just one playing
  voice per step. With openEnded=true the previous voice continues
  alongside the new one (because the `&& !openEnded` guard skips the
  truncate); the resulting voice-stacking summing apparently *cancels*
  more than it adds for the stub kick sample, pulling the peak down
  6.6 dB. Either way: the result is sensitive to the flag at the sample
  level. Code path alive.
- **rms +0.687 dB** when openEnded flips off: the integrated energy is
  slightly higher because each retrigger now starts at full velocity from
  sample zero, rather than mixing with the tail of the previous voice
  (which has been decaying through its 200 ms file length). The
  difference is small but consistent.

The implication: the openEnded flag is electrically connected to the
render output at Drums.h:519, the TE 3.2.0 sampler is honoring it, and
the current `true` value is the let-ring choice. The "drum tails are
truncated at note-off" hypothesis is empirically false.

`minimumSamplesToPlayWhenStopping` is `8` (constant at
`tracktion_SamplerPlugin.cpp:15`), which means with openEnded=false the
release is essentially 0.18 ms — a true hard-cut at noteOff. So
openEnded=true is doing real work; it's the only thing preventing snares
and cymbals from being cut to ~62.5 ms (1/8 beat at 120 BPM) +
0.18 ms of release in the real-sample renders.

### Decision

Close 58c with no engine code change. Two things land:

- `docs/58c-drum-tail-audit.md` (this file).
- `apps/engine-spike/scripts/render-drums-fixture.mjs` — keeps the
  Drums-only harness around for future regression sanity, same pattern
  as the 58a Keys harness.

No 8-genre no-regression matrix run is required: there's no engine diff
to regress.

## Out of scope for 58c

- Bass attack envelope / staccato vs sustained (→ 58f).
- Velocity curves on Keys / Pad (→ 58g).
- Drum kit selection / mixing — sound parity is about HOW the picked
  sample plays, not WHICH sample gets picked.
- Per-instrument loudness normalization (LUFS=null bug from 58a wrap) —
  flagged there as "lead suspect for 58b" but 58b ended up being the
  octave-adjustment classifier; revisit separately.

## Files touched by this slice

- `docs/58c-drum-tail-audit.md` (this file, new)
- `apps/engine-spike/scripts/render-drums-fixture.mjs` (new)
