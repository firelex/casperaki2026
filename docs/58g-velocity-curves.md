# 58g — Sound-parity audit: velocity curves

Status: closed — no port needed. The legacy reference state
(pre-`e825ad1`, 2023-11-30) used the SAME 0.9/0.7/0.5/0.3 ladder the
modern engine uses today. The `oldNormalisedVelocities` comment is
pre-legacy archaeology, NOT the legacy target.

Policy note: this slice was originally written as an A/B (swap the
ladders, measure rms / peak deltas, decide). The user redirected
mid-slice to "exact port of the legacy app, no A/B testing" for
phase-58. The decision now reduces to git-history: which ladder did
the engine use in the pre-`e825ad1` reference state?
Predecessor: 58a (Keys piano-sustain) — landed option (b) per-family
sustain-tail extension. 58c (drum tails) closed as no-op; 58f (bass
attack) closed as audit-done / fix-deferred. This slice picks up the
last of the 58a deferred items.

## Hypothesis (carried over from 58a)

> `addNoteToClip` applies `VelocityMode::beat` (the 0.9/0.7/0.5/0.3
> ladder at SequencerUtils.h:627). The legacy may have used a different
> ladder; if the chord-on-beat-1 velocity is too low (0.9 × 127 ≈ 114,
> that's fine actually) or the off-beat velocities are too low (0.3 × 127
> ≈ 38, that's whisper-quiet), the perceived dynamic profile will be
> wrong even before the tail issue is fixed.

The actual gift sitting in the code: a dead-code constant
`oldNormalisedVelocities {0.8, 0.7, 0.6, 0.5}` ten lines below the new
ladder. That's the engine author's own archaeology breadcrumb of a
previous ladder. We can probe directly: swap the new ladder for the old
one and compare.

## Map of the active velocity path

1. **Caller side.** `addNoteToClip (clip, timeNote, VelocityMode::beat)`
   is invoked from:
   - `Bass.h:50, 54` — both long-note and short-note branches.
   - `Synths.h:76` — Keys, Pad, Synths, popBrass, popStrings,
     orchestral, vocals (everything that extends `TonalInstrument`
     through `Synths`).
   - `Guitar.h:78, 82` — uses `VelocityMode::randomised` instead, not
     the beat ladder. Out of 58g scope.
   - `Drums.h` — uses StepClip, not MidiClip, so this path is bypassed
     entirely.

2. **Ladder dispatch.** `SequencerUtils.h:625–643`:

```cpp
inline void addNoteToClip(te::MidiClip *clip, const TimeNote &timeNote, VelocityMode velocityMode = none)
{
    std::vector<float> normalisedVelocities    {0.9, 0.7, 0.5, 0.3};
    std::vector<float> oldNormalisedVelocities {0.8, 0.7, 0.6, 0.5};

    int velocity = timeNote.velocity;

    if (velocityMode == VelocityMode::beat) {
        if (std::fmod(timeNote.start, 4.0) == 0.0)
            velocity = static_cast<int>(normalisedVelocities[0] * 127);   // 114
        else if (std::fmod(timeNote.start, 2.0) == 0.0)
            velocity = static_cast<int>(normalisedVelocities[1] * 127);   //  89
        else if (std::fmod(timeNote.start, 1.0) == 0.0)
            velocity = static_cast<int>(normalisedVelocities[2] * 127);   //  64
        else
            velocity = static_cast<int>(normalisedVelocities[3] * 127);   //  38
    } else if (velocityMode == VelocityMode::randomised) {
        velocity += (randomNumberGenerator.nextInt (127) - 65) / 5;
    }
    ...
}
```

3. **Sampler side.** TE SamplerPlugin reads velocity from the MIDI
   noteOn message and scales output gain by `m.getVelocity() / 127.0f`
   (`tracktion_SamplerPlugin.cpp:333`). Velocity-to-gain is linear; no
   velocity-curve sample-layer logic in the modern path.

4. **Dynamic profile per ladder**

   | beat position           | current (0.9/0.7/0.5/0.3) | old (0.8/0.7/0.6/0.5) | Δ (gain, 20·log)        |
   | ---                     | ---                       | ---                   | ---                     |
   | downbeat-of-bar (mod 4) | 114 (-1.0 dB)             | 102 (-1.9 dB)         | **-0.9 dB** (quieter)   |
   | beat-of-half (mod 2)    |  89 (-3.1 dB)             |  89 (-3.1 dB)         |  0.0 dB                 |
   | beat (mod 1)            |  64 (-5.9 dB)             |  76 (-4.5 dB)         | **+1.4 dB** (louder)    |
   | off-beat (sub-beat)     |  38 (-10.5 dB)            |  64 (-5.9 dB)         | **+4.6 dB** (louder)    |

   The old ladder is *flatter*: 1.9 dB downbeat-vs-loudest-off-beat
   versus today's 9.5 dB. So today's renders should have a more
   exaggerated downbeat accent and much quieter off-beat events. The
   user's 58a wrap perceptual flag ("less balanced than the original")
   is partly explained by this — off-beat events (passing chords,
   broken-chord arpeggios, 8th-note pad fills) sit ~4.6 dB lower
   relative to downbeats than they did in the legacy.

5. **Critical caveat.** This linear velocity-to-gain mapping does NOT
   model what most real samplers do — multi-zone velocity-layered
   samples (soft-layer / hard-layer with different timbres) are
   typically picked by velocity ranges, not gain-scaled. With single-
   layer stub samples we ONLY see the gain effect, not the timbral
   shift. With real velocity-layered piano samples this would matter
   more.

## Git history

- `git log -S "0.9, 0.7, 0.5, 0.3" -- Source/` → introduced in commit
  `ef1d6be — "Updated Casperaki Engine with latest batchutility!"`
  (2023-11-17).
- `git log -S "0.8, 0.7, 0.6, 0.5" -- Source/` → same commit `ef1d6be`.
- Both ladders entered the repo simultaneously when `SequencerUtils.h`
  was created (the function was moved out of a now-deleted predecessor
  in that same batch commit). The old ladder is preserved in code as
  comment-archaeology — the engine author left it behind as a "this is
  what we used to use" note rather than deleting it.

So `ef1d6be` is the commit where the dynamic profile got
*more aggressive*. That's also two weeks before the `e825ad1`
"Disable ADSR;" commit that 58a unpicked. The two commits are part of
the same "modernization" push that broke perceptual parity in
overlapping ways. 58a fixed the ADSR side; this slice probes the
ladder side.

## Validation plan and results

Two A/Bs against the existing post-58a-fix binary. The probe: swap
`normalisedVelocities` for `oldNormalisedVelocities` in the
`VelocityMode::beat` branch (one constant-name swap; the four cascaded
`fmod` selectors stay the same).

### Keys-only A/B

`apps/engine-spike/out/keys-fixture/{fix,velocity-old-ladder}.json`.
`fix.json` is the post-58a Keys baseline (SUSTAIN_TAIL_BEATS landed,
current 0.9/0.7/0.5/0.3 ladder); `velocity-old-ladder.json` is
SUSTAIN_TAIL_BEATS still landed PLUS the old 0.8/0.7/0.6/0.5 ladder.

| metric        | fix (current ladder) | velocity-old-ladder | delta      |
| ---           | ---                  | ---                 | ---        |
| durationSec   | 268.800              | 268.800             | 0.000 s    |
| peakDb        | 0.000                | 0.000               | 0.000 dB   |
| rmsDb         | -19.966              | -20.333             | **-0.367 dB** |
| tail.peakDb   | -24.373              | -20.436             | **+3.937 dB** |
| tail.rmsDb    | -36.835              | -32.898             | **+3.937 dB** |

The Keys fixture is a biased test of the velocity ladder: keys.ts emits
chord events on bar-downbeats only, so every event in the Keys lane
lands on `fmod(start, 4.0) == 0` and gets ladder slot 0 (velocity 114
under the current ladder; 102 under the old). The result is a uniform
-0.9 dB at the gain level on every Keys event — body RMS drops by
-0.367 dB (less than -0.9 dB because the master limiter compensates
somewhat at the limited 0 dB ceiling).

The +3.937 dB tail rise is the more interesting datum: quieter input
transients give the limiter less compression to do, so the natural
decay tails come through less squashed. That's an architectural
side-effect of the limiter, not the ladder itself.

### Bass-only A/B

`apps/engine-spike/out/bass-fixture/{baseline,velocity-old-ladder}.json`.
`baseline.json` is the 58f-captured post-58a-fix baseline.

| metric        | baseline (current ladder) | velocity-old-ladder | delta      |
| ---           | ---                       | ---                 | ---        |
| durationSec   | 268.800                   | 268.800             | 0.000 s    |
| peakDb        | -22.976                   | -25.023             | **-2.047 dB** |
| rmsDb         | -28.610                   | -30.184             | **-1.574 dB** |
| tail.peakDb   | -24.517                   | -26.564             | -2.047 dB  |
| tail.rmsDb    | -30.751                   | -32.799             | -2.048 dB  |

Bass has the same biased-toward-downbeats character in ballad: most
events land on the bar-downbeat slot. The result: body RMS drops
-1.574 dB; peak drops -2.047 dB. No limiter compensation at this gain
range (-23 dB peak headroom), so the linear -0.9 dB downbeat attenuation
shows through with no compression masking.

### Interpretation

Both A/Bs prove the ladder is electrically connected — the rms / peak
deltas are real and reproducible, not measurement noise. The direction
of effect is consistent with the ladder math:

| ladder slot   | new ladder velocity → old ladder velocity → Δ in linear gain |
| ---           | --- |
| downbeat (mod 4) | 114 → 102 = **-0.9 dB** (downbeat slightly quieter) |
| half (mod 2)     |  89 →  89 = **0.0 dB** |
| beat (mod 1)     |  64 →  76 = **+1.4 dB** |
| sub-beat         |  38 →  64 = **+4.6 dB** (off-beat much louder) |

So the old ladder is **flatter**: 1.9 dB dynamic range across slots vs
9.5 dB today. In a pattern-density-balanced render (equal events per
slot), the old ladder would yield a slightly louder rms and a more
even dynamic profile. In a downbeat-dominated render (ballad-style),
the old ladder is just quieter.

The 58a wrap perceptual flag ("less balanced than the original")
plausibly points at this — but "less balanced" might also point at the
LUFS=null bug or the missing per-instrument loudness normalization
flagged in 58a, both of which would also produce mix-balance drift
across instrument families. We have evidence the velocity ladder *is
audibly different* but not evidence that the old ladder is *the right*
balance.

### Decision per legacy-port policy

Reference timeline (from `git log` on `casperaki_engine`):

- `ef1d6be` (2023-11-17) — `SequencerUtils.h` introduced, with BOTH
  `normalisedVelocities {0.9, 0.7, 0.5, 0.3}` and
  `oldNormalisedVelocities {0.8, 0.7, 0.6, 0.5}` in the same file.
  The active call site uses `normalisedVelocities`; the "old" constant
  is preserved as a comment-archaeology breadcrumb of the previous
  velocity ladder.
- `e825ad1` (2023-11-30) — "Disable ADSR;" commit. 58a's reference
  "legacy" is the engine state immediately BEFORE this commit.

So the engine state at the 58a legacy reference (between `ef1d6be` and
`e825ad1`) used `normalisedVelocities`. The modern engine still uses
`normalisedVelocities`. **The ladder is at parity. No code change.**

The `oldNormalisedVelocities` value is from an even-earlier era that
predates the 58a-defined legacy reference; porting it would be moving
the engine FURTHER from the legacy, not closer. The 58a wrap's
"the legacy may have used a different ladder" speculation was wrong
about this specific lane.

### A/B numbers (provenance, no longer driving the decision)

For the record, the A/Bs that were run before the policy pivot. Both
swapped `normalisedVelocities` for `oldNormalisedVelocities` in the
`VelocityMode::beat` branch only:

| fixture | metric    | current ladder | old ladder | delta      |
| ---     | ---       | ---            | ---        | ---        |
| keys    | rmsDb     | -19.966        | -20.333    | -0.367 dB  |
| keys    | tail.rmsDb | -36.835       | -32.898    | +3.937 dB  |
| bass    | peakDb    | -22.976        | -25.023    | -2.047 dB  |
| bass    | rmsDb     | -28.610        | -30.184    | -1.574 dB  |

These confirm the code path is alive but do not change the decision —
the legacy used the current ladder. Both fixtures' baseline.wav files
remain on disk as references for any future per-instrument velocity
work (a possible 58a-option-(c) shape, brain-side per-family
`velocityProfile`), which is out of scope for phase-58's legacy-port
remit.

### Out of scope for 58g (already noted above)

- Velocity-curve nonlinearity at the sampler (linear vs power curve).
  TE's `SamplerPlugin` is linear; legacy's `CasperakiSamplerPlugin` is
  also linear (`CasperakiSamplerPlugin.cpp:48`: voice gain initialized
  from `velocity * baseGain`, no curve). No legacy port needed.
- Per-instrument velocity profiles — a future 58a-option-(c)-shaped
  change for non-legacy refinement.
- `VelocityMode::randomised` used by Guitar — different code path,
  ladder doesn't apply.

## Out of scope for 58g

- Velocity-curve mapping (linear vs exponential vs S-curve at the
  sampler input). The engine currently passes velocity straight to TE,
  which scales gain linearly. Changing this is sampler-side work and
  has nothing to do with the ladder selection.
- Per-instrument velocity profiles (e.g. piano with a softer downbeat
  vs synth with a harder downbeat). Would be the 58a option-(c) shape
  if a per-family knob is ever needed.
- The `randomised` mode used by Guitar — different code path, no
  ladder.

## Files touched by this slice

- `docs/58g-velocity-curves.md` (this file, new)
- `casperaki_engine/Source/instruments/SequencerUtils.h` — no
  change; legacy already at parity.
- `apps/engine-spike/out/keys-fixture/velocity-old-ladder.{wav,json}`,
  `apps/engine-spike/out/bass-fixture/velocity-old-ladder.{wav,json}` —
  A/B artefacts from the pre-pivot pass, kept on disk for any
  future per-family velocity work.
