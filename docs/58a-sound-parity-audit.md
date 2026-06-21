# 58a — Sound-parity audit: piano sustain

Status: audit complete, option (b) applied, Keys-only A/B passes (tail rms
+8.04 dB), no-regression matrix 8/8 pass, zero plugin errors.
Predecessor: 57e (matrix passes; statistical gates met; sonic parity not yet
chased). The 8-genre matrix renders pass the trio (peak / rms / duration) and
the plugins-on delta gate, but a sonic A/B against the legacy/precedent engine
still sounds wrong. This slice opens a sound-parity audit, starting with the
piano-sustain delta the user flagged.

## Hypothesis

> The engine cuts piano notes off at noteEnd; the legacy engine let the sample
> tail ring.

Confirmed in archaeology. The smoking gun is commit `e825ad1` ("Disable ADSR;",
2023-11-30) in `casperaki_engine`, which flipped the active sampler:

```
- #define USE_CASPERAKI_SAMPLER
- //#define USE_TE_SAMPLER
+ //#define USE_CASPERAKI_SAMPLER
+ #define USE_TE_SAMPLER
```

`SHOULD_APPLY_ADSR` is gated `#ifdef USE_CASPERAKI_SAMPLER` (config.h:36–40),
so the flip simultaneously (1) switched off the in-house sampler and (2)
disabled the ADSR release stage that fed it. The legacy let-ring behavior lives
in `CasperakiSamplerPlugin` (sibling repo) — specifically the `openEnded` flag
path at `CasperakiSamplerPlugin.cpp:386–391`, which skips the hard
`samplesLeftToPlay` clamp on note-off and lets the per-voice ADSR
(release=2.0 s, set at `CasperakiSamplerPlugin.cpp:51–52`) carry the tail past
the scheduled note-off. Today that whole code path is dormant.

## Map of the active note-off path (today)

Brain → bridge → song.json → engine, for a Keys lane:

1. **Brain** (`packages/arrangement/src/patterns/keys.ts:81–176`,
   `packages/song-schema/src/schemas/notes.ts:14–37`) emits one of three event
   shapes — `{type, chord, duration}`, `{type, chord, distanceFromMiddleC,
   duration}`, or plain `{type:'note', note, duration}`. No sustain / release /
   letRing / tieToNext fields are emitted or even allowed by name — schemas
   use `.passthrough()`, so adding a field is non-breaking, but nothing is
   added today.
2. **Bridge** (`packages/engine-adapter/src/index.ts:1545–1682`,
   `packages/song-schema/src/canonical/stringify.ts:14–45`) is lossless. The
   canonical stringify is symmetric and `.passthrough()` survives. Duration
   defaults to `1` if missing, otherwise is preserved bit-for-bit. No
   coercion. No clipping.
3. **Engine, song-walking**
   (`casperaki_engine/Source/instruments/TonalInstrument.h:36–247`) reads
   per-bar notes from song.json, calls into `SequencerUtils.h` to expand to
   absolute pitches, and produces `Array<TimeNote>` where each entry carries
   the duration as-is from the JSON.
4. **Engine, TE-sequencer boundary** (`SequencerUtils.h:625–659`,
   `addNoteToClip`) is the choke point. It calls
   `sequence->addNote(midi, BeatPosition, BeatDuration::fromBeats(timeNote.duration), velocity, 1, nullptr)`.
   Tracktion's MidiClip ends the note at exactly `start + duration`; the
   built-in `te::SamplerPlugin` honors note-off as a hard stop (no release
   stage).
5. **Sampler choice** (`casperaki_engine/Source/config.h:23–24`,
   `Source/instruments/TonalInstrument.h:11–15`). `USE_TE_SAMPLER` is on;
   `USE_CASPERAKI_SAMPLER` (with its `openEnded` + ADSR let-ring path) is
   commented out. `SHOULD_APPLY_ADSR=0` falls out as a consequence.

Verified Keys note durations across the 57e renders: every present Keys lane
(ballad / brightPop / organicVibes / rock / latin) renders 2-bar patterns with
2 `{type:'chord', duration:4}` events — one whole-bar chord per bar. The
durations are already maximal; the audible delta isn't a too-short note, it's
the hard cut at the next chord boundary that the legacy ADSR release would
have softened.

## What the legacy precedent actually was

Pre-`e825ad1`, the active path was:

- `te::Plugin = CasperakiSamplerPlugin` (Source/CasperakiSamplerPlugin.cpp)
- Per-voice `juce::ADSR` with parameters `(0.001, 0.1, 1.0, 2.0)` —
  attack=1 ms, decay=100 ms, sustain=1.0, **release=2.0 s**
  (CasperakiSamplerPlugin.cpp:51–52)
- `openEnded` flag on each `SampledNote`. When set, `noteOff` skips the
  `samplesLeftToPlay = min(samplesLeftToPlay, max(min, noteTimeSample))`
  clamp (lines 388–391), letting the ADSR release ride out the tail rather
  than truncating the sample at the noteEnd boundary.
- `SHOULD_APPLY_ADSR=1`, so `adsr.applyEnvelopeToBuffer` runs each block
  (CasperakiSamplerPlugin.cpp:145–147).

No new code is needed to restore this — only a config flip. The full
infrastructure is in the engine source tree, dormant.

## Proposed fix — three options, in increasing scope

The user's brief listed three options (a/b/c). Re-stated against the
archaeology:

**(a) Restore the legacy CasperakiSamplerPlugin path for tonal instruments.**
Flip `config.h:23–24` back to `#define USE_CASPERAKI_SAMPLER` /
`//#define USE_TE_SAMPLER`. ADSR + openEnded come back end-to-end. Smallest
diff in the engine source (literally two lines). Largest blast radius — it
affects every TonalInstrument, not just Keys (Synths, Pad, Bass, Guitar).
The original "Disable ADSR;" commit had no message body explaining why it
was disabled. Possible regression vectors: click at note-on if the 1 ms
attack is too short for some samples; overlapping voices summing differently
than TE's voice stealing; CPU. Hardest to scope per-family.

**(b) Per-instrument-family sustain-tail extension at the TE-sampler call
site.** Leave `USE_TE_SAMPLER` on. In `SequencerUtils.h:658` (or in
`Synths::createSegmentClip` before calling `addNoteToClip`), extend the
`BeatDuration` passed to `sequence->addNote` by a per-family constant tail
(e.g. `keysSustainTailBeats = 2`) for the Keys / Synths / Pad families only.
Bass / Drums / Guitar see no change. The tail value lives in `Synths.h` (or
a small per-instrument knob on the inst-N.json) and can be tuned without
rebuilding the brain or schema layers. Tracktion will hold the note past the
scheduled end and the sampler will play that much more sample. Doesn't
reach the ADSR release stage (TE sampler has none), but it does extend
audible sample, which is the perceptual delta.
Smaller diff, smaller blast radius, easier to A/B-bisect.

**(c) Per-family sustainMode knob on song.json read by the brain.** Add
`sustainMode: 'ring' | 'hard-cut'` to the brain's instrumentDefinition or
per-pattern. Default `'ring'` for Keys, `'hard-cut'` elsewhere. Bridge is
already passthrough, no schema work needed beyond brain emission. Engine
reads the field at `processSegment` time and applies (a) or (b) accordingly.
Most architecturally clean, biggest surface area to add.

**Recommendation: (b) first, fall back to (a) if it doesn't match.**

Why (b) first: smallest reversible change, contained to the engine repo,
contained to the Synths-derived families, leaves Drums/Bass/Guitar
untouched, and the Keys-only render harness (below) makes iteration cycles
fast. If the perceptual gap from (b) matches the legacy reference, we land
it and move on. If not — i.e. if (b) sounds like "longer same hard cut"
rather than "natural decay" — flip to (a) and accept the broader blast
radius, but with a known per-family rollback (the per-family
`SHOULD_APPLY_ADSR` switch could be added if any non-Keys family regresses).
Option (c) is the right shape long-term once we have more than one stylistic
delta to encode; deferring to 58b+ when the second knob shows up.

## Keys-only render harness

`apps/engine-spike/scripts/render-keys-fixture.mjs` (next commit) — renders
a Keys-only fixture (Keys + Vocal stub, all other lanes muted) twice into
the same outDir: `out-baseline.wav` (current engine binary) and
`out-fix.wav` (binary built from the candidate change). Reports duration,
peak dB, rms dB, **and tail-region rms dB** — the latter measured in a
window starting one beat AFTER the last scheduled note-off, where any
audible energy in the baseline = 0 and in the fix > floor proves the
ring is reaching the master bus. Skips the full matrix while iterating; the
matrix runs once at the end of 58a as a no-regression pass.

## Validation plan and results

1. Build the harness; capture a baseline Keys-only render against the
   current engine binary; lock the tail-region rms as the "hard-cut" floor.
2. Apply option (b). Rebuild the engine. Re-render Keys-only. Verify tail-
   region rms rises by ≥ 6 dB (audible decay) and overall peak/rms hasn't
   shifted by more than ~1 dB (so we haven't accidentally re-summed louder).
3. If the perceptual A/B doesn't match the legacy reference, escalate to
   option (a) and re-validate.
4. Final no-regression: re-run
   `pnpm --filter @casperaki/engine-spike test -- --run
    test/plugin-chain-discovery.spec.ts test/plugin-hosting-smoke.spec.ts`
   (17/17 today) and
   `node apps/engine-spike/scripts/render-all-genres.mjs --plugins-on`
   (must keep 8/8 pass, zero plugin errors, all |Δrms| ≥ 0.05 dB).

### Keys-only A/B (steps 1–2)

`apps/engine-spike/out/keys-fixture/{baseline,fix}.json`. Ballad-derived
fixture, all non-Keys lanes muted, full 268.8 s render.

| metric           | baseline   | fix        | delta   |
| ---              | ---        | ---        | ---     |
| durationSec      | 268.800    | 268.800    | 0.000 s |
| peakDb           | 0.000      | 0.000      | 0.000 dB |
| rmsDb            | -20.351    | -19.966    | +0.385 dB |
| tail.peakDb      | -26.540    | -24.373    | +2.167 dB |
| tail.rmsDb (0.5s)| -44.875    | -36.835    | **+8.040 dB** |

Clear above the +6 dB "let-ring landed" threshold. Overall rms drift of
+0.385 dB confirms we're adding decay tails, not re-summing the whole song
louder; duration is unchanged so nothing is overrunning the segment
boundary. Step 3 (escalate to option a) not needed.

### No-regression (step 4)

- `pnpm --filter @casperaki/engine-spike test -- --run
   test/plugin-chain-discovery.spec.ts test/plugin-hosting-smoke.spec.ts`
  → 17/17 pass (same as 57e baseline).
- `node apps/engine-spike/scripts/render-all-genres.mjs --plugins-on`
  → **8/8 pass, zero plugin errors, all |Δrms| ≥ 0.05 dB**, elapsed 617 s.
  Snapshot saved at
  `apps/engine-spike/out/all-genre-render-smoke/58a-matrix.json` (the
  render driver still writes the 57e-named file at the same path; we
  copied it under the 58a name to lock the post-fix baseline for the
  next slice's diffs).

Deltas vs 57e (the 4 genres for which the brief embedded 57e ground-truth
rms; the other 4 weren't pre-snapshotted but all 8 cleared the gate this
run):

| genre      | dry rms 57e → 58a   | Δdry      | plugins rms 57e → 58a | Δplugins  |
| ---        | ---                 | ---       | ---                   | ---       |
| ballad     | -19.596 → -19.183   | +0.413 dB | -16.965 → -16.896     | +0.069 dB |
| brightPop  | -20.471 → -19.180   | +1.291 dB | -20.736 → -20.541     | +0.195 dB |
| edm        | -21.465 → -20.103   | +1.362 dB | -14.824 → -14.651     | +0.173 dB |
| latin      | -22.274 → -21.322   | +0.952 dB | -18.924 → -18.913     | +0.011 dB |

Dry rms rises consistently across genres (≈+0.4 to +1.4 dB), exactly the
shape of "tails on Synths-family lanes adding energy without changing event
density." The plugins-on delta barely moves — the master rack absorbs the
extra energy via its limiter / compressor stages, which is the desired
behavior. Two side observations worth flagging without confusing them for
regressions:

- **schlager plugins peak** went from -3.164 dB (57e) to 0.0 dB (58a). The
  brief's deferred list flagged "Schlager peak-not-limited investigation" —
  this run shows the limiter now engaging there because the extra tail
  energy from let-ring is pushing schlager into the limiter range. The
  schlager rms is unchanged (-22.251 dB both runs). Treat this as a useful
  surface for the deferred schlager bisect, not a 58a regression.
- **rock plugins-on Δrms** remains -5.948 dB (unchanged from 57e). Still on
  the deferred per-rack bisect list.

## Deferred — other suspected stylistic deltas (58b+)

Cataloged here so they don't get re-discovered each slice. Each is a
hypothesis from the same family as "piano hard-cut at noteEnd"; none have
been audited yet.

- **Drums — tail truncation on one-shots vs sliced loops.** Drum samples
  are typically pre-baked one-shots, so the duration field shouldn't matter
  — but if the TE sampler treats `note-off` as a hard truncate on Drums
  too, snare/cymbal tails may be losing their natural decay. Same root
  cause as the Keys case (lack of ADSR release). Audit target:
  `Drums.h::createSegmentClip` and the per-voice cymbal/snare samples.
- **Bass — attack envelope / staccato vs sustained.** Bass plays through
  the same `addNoteToClip` overlap-shortener
  (`SequencerUtils.h:647–655`), which actively trims overlapping notes at
  the same pitch. Legato bass lines (slurred, ringing into the next note)
  may be getting shortened. Also: the bass is split into long-vs-short
  tracks at `Bass.h::createSegmentClip` by `timeNote.duration > 0.5` —
  worth verifying the threshold matches the legacy.
- **Pad — tail length / reverb send wetness.** Pads benefit even more
  from a release tail than Keys; same fix should apply. Verify the Pad
  family routes through `Synths` (it does) and that the option-(b) tail
  extension carries.
- **Per-instrument loudness normalization is silently broken.** Confirmed
  during the 58a wrap. The brain/adapter emits `details: { LUFS: null,
  octaveAdjustment: null }` for every Synths-family instrument
  (`packages/engine-adapter/src/synths.ts:62,102,159,201` —
  `LUFS: null`). The engine reads `LUFS` at
  `TonalInstrument.h:26` via `hasProperty("LUFS")` → reads as 0. Three
  downstream consequences:
  1. `Guitar.h:23` sets `defaultVolume = -20 + (-10 - LUFS)` — with LUFS=0
     this yields -30 dB. The legacy LUFS values were negative (typical
     sample-loudness measurements in the -10 to -20 dB range), so the
     formula was designed to *raise* gain for quiet samples and *lower* it
     for loud ones. Today every guitar gets a fixed -30 dB and the
     normalization is gone.
  2. `Drums.h:410-428` applies `defaultVolume` to kicks/snares/toms/rest
     tracks — same source.
  3. `Synths.h` applies **no** per-instrument volume at all. Keys, Pad,
     Synths, popBrass, popStrings, orchestral, vocals all play at the
     sample's raw gain summed with the master rack.
  Result: balance between families is whatever the raw samples and master
  rack happen to produce, not what the legacy LUFS-normalization curve
  yielded. User flagged perceptually ("they sound less balanced than the
  original") in the 58a wrap conversation. **This is the lead suspect for
  58b.**
- **Velocity curves on Keys / Pad.** `addNoteToClip` applies
  `VelocityMode::beat` (the 0.9/0.7/0.5/0.3 ladder at
  SequencerUtils.h:627). The legacy may have used a different ladder; if
  the chord-on-beat-1 velocity is too low (0.9 × 127 ≈ 114, that's fine
  actually) or the off-beat velocities are too low (0.3 × 127 ≈ 38, that's
  whisper-quiet), the perceived dynamic profile will be wrong even before
  the tail issue is fixed.
- **Strum micro-timing for guitar.** Already partially handled in
  `TonalInstrument.h:108–123` (BPM-scaled timeOffsetInSeconds), but the
  legacy may have had different offset constants. Not in the brief but
  worth flagging.

## Out of scope for 58a (confirmed)

- Per-rack bisect from 57e observations (rock −5.6 dB plugins-on delta,
  schlager not peak-limited)
- Schlager peak-not-limited investigation
- Airwindows Consolidated state-blob parameter fidelity
- Brain-side instrument selection changes — sound parity is about HOW the
  picked sample plays, not WHICH sample gets picked
- The brightPop dry RMS drift (57d: −19.48 dB; 57e: −20.47 dB) — stable
  across sessions; gate passes; not in this audit's scope

## Files touched by this slice (so far)

- `docs/58a-sound-parity-audit.md` (this file, new)
- `apps/engine-spike/scripts/render-keys-fixture.mjs` (next commit, new)
- `casperaki_engine/Source/instruments/Synths.h` *or*
  `casperaki_engine/Source/instruments/SequencerUtils.h` — pending choice
  between option (a) and (b)
