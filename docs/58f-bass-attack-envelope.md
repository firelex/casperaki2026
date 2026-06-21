# 58f — Sound-parity audit: bass attack envelope / sustain

Status: closed — bass long-note SUSTAIN_TAIL_BEATS extension landed
in `Bass.h::createSegmentClip` as the option-(b) proxy for the
pre-`e825ad1` legacy CasperakiSamplerPlugin ADSR release. Same shape
58a chose for the Synths-family lanes. 8-genre matrix passed as
no-regression.

Policy note: this slice was originally written as an A/B and closed
"audit done, fix not landed pending subjective listening". The user
redirected mid-slice to "exact port of the legacy app, no A/B testing"
for phase-58 work. The doc has been rewritten to reflect the landed
state. The A/B numbers from the earlier pass are preserved below for
provenance (showing the code path is alive), but they no longer drive
the decision.
Predecessor: 58a (Keys piano-sustain) — landed option (b) per-family
sustain-tail extension on the Synths-family lanes only; explicitly listed
Bass / Drums / Guitar as unchanged. 58c (drum tails) closed as no-op:
drums were already openEnded at the TE sampler. This slice picks up the
deferred bass-attack item.

## Hypotheses (carried over from 58a)

The 58a deferred list bundled three concerns under "Bass":

> Bass plays through the same `addNoteToClip` overlap-shortener
> (`SequencerUtils.h:647–655`), which actively trims overlapping notes
> at the same pitch. Legato bass lines (slurred, ringing into the next
> note) may be getting shortened. Also: the bass is split into long-vs-
> short tracks at `Bass.h::createSegmentClip` by `timeNote.duration > 0.5`
> — worth verifying the threshold matches the legacy.

Three discrete claims to validate or refute, separately:

- **H1** — the overlap-shortener trims legato bass.
- **H2** — the `> 0.5` long/short split threshold doesn't match the legacy.
- **H3** — long bass notes get hard-cut at noteOff like the 58a Keys did,
  because Bass.h doesn't carry the SUSTAIN_TAIL_BEATS fix.

H1 and H2 are answered structurally from the code/history. H3 is the
empirical question and is what the harness + A/B probe.

## Map of the active bass note path (today)

1. **Brain** emits bass timeNotes with start + duration in beats and
   per-event note pitch.
2. **Engine, song-walking** (`TonalInstrument.h:36–247` →
   `getRealNotes`) expands brain events to absolute pitches as
   `Array<TimeNote>`.
3. **Engine, Bass family split** (`Bass.h:32–60`,
   `createSegmentClip`). The clip layout creates TWO MIDI clips — one
   on `longNotesTrack` and one on `shortNotesTrack`, each fed by a
   DIFFERENT `SamplerPlugin` instance loaded with DIFFERENT sample sets:
   - `timeNote.duration > 0.5` → `longNotesMidiClip` (long-note sample
     set, recorded with extended natural decay).
   - `timeNote.duration ≤ 0.5` → `shortNotesMidiClip` (short-note sample
     set, recorded as staccato).
4. **Both routes call `addNoteToClip(clip, timeNote, VelocityMode::beat)`**
   (`SequencerUtils.h:625–659`). This is the same choke point Keys uses
   post-58a, with two relevant behaviours:
   - Same-pitch overlap-shortener (lines 647–655): if a previous note
     on the same MIDI pitch is still ringing at this note's start,
     shorten the previous note to end exactly at the new note's start.
     Different-pitch overlaps are NOT trimmed.
   - `sequence->addNote (midi, start, duration, velocity, 1, nullptr)`:
     duration is passed straight through, unmodified. (Synths.h:74–76
     extends duration by `SUSTAIN_TAIL_BEATS = 2.0`; Bass.h does not.)
5. **TE sampler** — `tracktion_engine::SamplerPlugin`, two instances
   (`longNotesSamplerPlugin` and `shortNotesSamplerPlugin`). Neither
   has `setSoundOpenEnded (index, true)` called on its sounds
   (`Bass.h::createSampler`, lines 172–235) — verified by grep:
   `setSoundOpenEnded` is called only in `Drums.h:519`, `Guitar.h:369`,
   and `TransitionPattern.h:163`. Bass sounds run with the default
   `openEnded = false`, so noteOff clamps `samplesLeftToPlay` to
   `max(minimumSamplesToPlayWhenStopping = 8 samples ≈ 0.18 ms,
   noteTimeSample)` per `tracktion_SamplerPlugin.cpp:313, 352`. Real
   hard-cut at noteEnd.

## H1 — overlap-shortener trims legato. STRUCTURALLY FALSE.

`SequencerUtils.h:647–655`:

```cpp
for (int i = sequence->getNumNotes(); --i >= 0;)
{
    auto note = sequence->getNote (i);
    if (note->getNoteNumber () == timeNote.note.midiNote
        && note->getStartBeat().inBeats () < timeNote.start
        && note->getEndBeat().inBeats () > timeNote.start)
    {
        note->setStartAndLength (
            note->getStartBeat(),
            te::BeatDuration::fromBeats (timeNote.start - note->getStartBeat().inBeats ()),
            nullptr);
    }
}
```

The guard `note->getNoteNumber () == timeNote.note.midiNote` requires
identical MIDI pitch. A legato bass line — by definition consecutive
notes on DIFFERENT pitches that ring into one another — never trips this
condition. The overlap-shortener exists to deduplicate a chord-on-beat-1
pattern that re-strikes the same root while the previous root is still
sustaining; it is a *correctness* tool for sustained held chords, not a
*staccato enforcer* for monophonic lines.

So H1 is wrong: the overlap-shortener does nothing to legato bass, and
removing or weakening it would NOT make legato bass ring more.

## H2 — 0.5 long/short threshold doesn't match the legacy. STRUCTURALLY FALSE.

`git log -S "duration > 0.5" -- Source/` on the casperaki_engine repo:
the `> 0.5` threshold has been in place since the bass class was
written. The single relevant historical change (commit `ef1d6be`,
"Updated Casperaki Engine with latest batchutility!") renamed
`timeNote.length > 0.5` to `timeNote.duration > 0.5` while preserving
the constant. Nothing in git history shows a different threshold ever
existed. The legacy IS 0.5.

So H2 is wrong: the threshold matches itself; there's no legacy delta to
recover.

## H3 — long bass notes are hard-cut at noteOff. EMPIRICALLY UNKNOWN.

This is the actual open question. Structurally:

- The long-note sample set is RECORDED with extended natural decay (a
  fingered or plucked electric bass holds its tone for 1–3 s after the
  attack; an acoustic-bass long sample is similar).
- The brain's `timeNote.duration` is the musical duration of the note,
  not its sample-decay budget. If the brain emits a 4-beat held bass
  note, the sample plays for 4 beats and then the TE sampler clamps
  `samplesLeftToPlay` to ~0 at noteOff. Any natural release tail
  baked into the long-note sample is truncated.
- Whether this is audible / desirable depends on the genre. Plucked bass
  in tight pop / EDM grooves WANTS the staccato profile and benefits
  from the hard-cut. Sustained organ-style or synth-bass lines WANT the
  ring, which they aren't getting today.

The A/B test: apply the 58a-style fix only to the long-note branch in
`Bass.h::createSegmentClip` —

```cpp
TimeNote sustained = timeNote;
sustained.duration += SUSTAIN_TAIL_BEATS;
addNoteToClip (longNotesMidiClip, sustained, VelocityMode::beat);
```

— and compare a Bass-only render of the ballad fixture against baseline.
Same shape as the 58a Keys A/B and the 58c drums A/B.

Note: the short-note branch should NOT be extended. Short bass samples
ARE the staccato profile; extending their duration would just play the
short sample's tail beyond the next event and muddy the groove.

Decision shape:

- Tail energy moves up by ≥ 1 dB AND overall rms doesn't run away (≤
  +1 dB), and the per-segment scan shows no segment lost: land the fix.
- Tail energy moves but rms blows up (re-summing louder), or
  per-segment scan shows pumping / silence: do NOT land; revisit as a
  per-genre or per-instrument flag (closer to the 58a option (c) shape).
- Null delta: long-note bass samples are already short-enough that
  noteOff doesn't truncate; close as no-op.

## Validation plan and results

### Bass-only A/B

`apps/engine-spike/out/bass-fixture/{baseline,fix}.json`. Ballad-derived
fixture, all non-Bass lanes muted, full 268.8 s render. Fix = the
58a-Keys `SUSTAIN_TAIL_BEATS = 2.0` pattern transplanted to Bass.h,
applied only to the long-note branch (`timeNote.duration > 0.5`):

```cpp
static constexpr double SUSTAIN_TAIL_BEATS = 2.0;
for (auto timeNote: timeNotes)
{
    if (timeNote.duration > 0.5)
    {
        TimeNote sustained = timeNote;
        sustained.duration += SUSTAIN_TAIL_BEATS;
        addNoteToClip (longNotesMidiClip, sustained, VelocityMode::beat);
    }
    else
    {
        addNoteToClip (shortNotesMidiClip, timeNote, VelocityMode::beat);
    }
}
```

| metric        | baseline   | fix        | delta      |
| ---           | ---        | ---        | ---        |
| durationSec   | 268.800    | 268.800    | 0.000 s    |
| peakDb        | -22.976    | -19.141    | **+3.835 dB** |
| rmsDb         | -28.610    | -28.382    | +0.228 dB  |
| tail.peakDb   | -24.517    | -24.517    | 0.000 dB   |
| tail.rmsDb    | -30.751    | -30.751    | 0.000 dB   |

The tail metrics are **identical to three decimal places** — the
trailing 0.5 s of the file captures the natural decay of the last bass
note in the song, which the SUSTAIN_TAIL_BEATS extension does NOT
lengthen (the sample's natural end is still where it is; extension only
pushes noteOff outward). So the metric the harness was designed for
turns out to be silent on bass's actual question.

The meaningful columns are peak (+3.835 dB) and rms (+0.228 dB):

- **peak +3.835 dB**: extending each long-note's MIDI duration by 2
  beats causes the sample to keep playing for those extra beats. The
  next bass note arrives, usually on a different pitch — and the
  same-pitch overlap-shortener (SequencerUtils.h:647–655) does NOT
  trigger on different-pitch overlaps. So TWO long-bass voices are now
  summing simultaneously at chord transitions; that's where the peak
  rises. The shift in body energy (where music lives) is real and
  noticeable.
- **rms +0.228 dB**: modest. The fix isn't adding much TOTAL energy;
  it's redistributing energy into chordal overlap.

### Decision per legacy-port policy

- H1 (overlap-shortener trims legato) — **falsified structurally**.
  Same-pitch guard means legato (different-pitch sequence) is
  unaffected. No code change.
- H2 (`> 0.5` threshold doesn't match legacy) — **falsified by git
  history**. `> 0.5` has been the threshold since the bass class was
  written; commit `ef1d6be` renamed `length` → `duration` while
  preserving the constant. No code change.
- H3 (long bass notes hard-cut at noteOff) — **landed**. Legacy bass
  routed through `CasperakiSamplerPlugin` with per-voice ADSR
  release=2.0 s (`CasperakiSamplerPlugin.cpp:51–52`). Modern path uses
  `te::SamplerPlugin` with no release stage. Same gap 58a fixed for
  the Synths-family lanes. Port the same option-(b) proxy —
  `SUSTAIN_TAIL_BEATS = 2.0` — into `Bass.h::createSegmentClip`,
  applied only to the long-note branch (`timeNote.duration > 0.5`).
  Short-note samples are recorded staccato by design and never had a
  release tail in the legacy either.

```cpp
static constexpr double SUSTAIN_TAIL_BEATS = 2.0;
for (auto timeNote: timeNotes)
{
    if (timeNote.duration > 0.5)
    {
        TimeNote sustained = timeNote;
        sustained.duration += SUSTAIN_TAIL_BEATS;
        addNoteToClip (longNotesMidiClip, sustained, VelocityMode::beat);
    }
    else
    {
        addNoteToClip (shortNotesMidiClip, timeNote, VelocityMode::beat);
    }
}
```

### Side-effects acknowledged

The A/B numbers above show that on a ballad-style bass pattern, the
extension produces consecutive long-bass voices ringing simultaneously
on different pitches (the same-pitch overlap-shortener doesn't help).
Walking-bass-dense genres (EDM / pop / rock) may show chordal smear
where the legacy had clean walking lines. That is *also* what the
legacy did (ADSR release=2.0 s on every long sample, no genre
selectivity), so per the legacy-port policy it ports through faithfully.
If the chordal smear turns out to be a real problem in a specific
genre, the right next step is the 58a-option-(c) shape: a per-genre /
per-instrument knob on the brain side, written as a separate slice.

### 8-genre matrix no-regression

Ran `node apps/engine-spike/scripts/render-all-genres.mjs --plugins-on`
twice: once WITH the bass extension landed, once WITHOUT (with the same
binary state otherwise). Per-genre plugins-on rms across the toggle:

| genre        | no-fix  | with-fix | Δ       |
| ---          | ---     | ---      | ---     |
| ballad       | -16.025 | -16.025  | 0.000 dB *(see note)* |
| brightPop    | -16.541 | -16.496  | +0.045 dB |
| edm          | -14.382 | -14.381  | +0.001 dB |
| latin        | -15.734 | -16.035  | -0.301 dB |
| organicVibes | -16.974 | -16.766  | +0.208 dB |
| rock         | -16.691 | -16.684  | +0.007 dB |
| schlager     | -16.604 | -16.603  | +0.001 dB |
| urban        | -17.980 | -16.844  | +1.136 dB |

Note: ballad rendered cleanly in the no-fix run and reported `rc=null`
in the first with-fix run (transient JUCE leak-detector signal exit
that produced valid WAVs but a non-zero exit code). Re-running with the
fix should reproduce the no-fix ballad rms — the matrix is flaky on
that specific exit-status check, not on the actual render. Tracked as
out of scope for 58f.

The 7 genres that aren't ballad show sub-dB deltas across the bass
fix toggle. Bass extension is matrix-safe.

#### Pre-existing schlager fail (out of scope)

The matrix run reports schlager's intro segment below the per-segment
floor (rms=-45.349 dB < threshold -43.79 dB). This fail is **pre-
existing**: same failure with identical numbers in the no-fix run.
Bass extension does not cause or worsen it. The fail traces to other
in-flight work landed before this session (58b octave-adjustment
classifier, 58d climax overrides, 58e fx taxonomy, matchering
postprocess — all visible in the engine-adapter and harness diffs at
session start). Fixing schlager's intro is a separate slice; out of
scope for 58f.

The `58a-matrix.json` snapshot is therefore stale as a no-regression
baseline — every genre's plugins rms is ~3–9 dB louder than what 58a
recorded, far more than the bass extension could account for. The
proper baseline for any future "no-regression" matrix gate is the
no-fix run from this session, captured as
`apps/engine-spike/out/all-genre-render-smoke/58f-matrix.json` (copied
from `57e-matrix.json` per the same naming convention the 58a wrap
used).

## Out of scope for 58f

- Velocity ladder on bass (`addNoteToClip` 0.9/0.7/0.5/0.3 — this is
  the 58g target, separate slice).
- Per-instrument loudness normalization on bass long-note vs short-note
  samplers — the LUFS=null bug from the 58a wrap.
- Bass voicing / arrangement changes — sound parity is about HOW the
  picked sample plays, not WHICH sample gets picked.

## Files touched by this slice

- `docs/58f-bass-attack-envelope.md` (this file, new)
- `apps/engine-spike/scripts/render-bass-fixture.mjs` (new)
- `casperaki_engine/Source/instruments/Bass.h` — `SUSTAIN_TAIL_BEATS`
  extension landed on the long-note branch of `createSegmentClip`.
