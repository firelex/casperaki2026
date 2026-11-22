# Resolution port map — `casperaki_engine` → WASM `Resolver`

Exact source anchors for porting `song.json` resolution into `src/Resolver.h`.
All paths under `~/apps/casperaki_engine/Source/`. Re-implement (not lift): the
originals are `te::`-coupled. Validate each increment with
`scripts/validate-resolution.mjs`.

| Concern | File | Function | Lines |
| --- | --- | --- | --- |
| **Main entry / segment loop** | `sequencer/Sequencer.cpp` | `Sequencer::setSong` | 373–499 |
| Tempo + bars→beats→sec | `sequencer/Sequencer.cpp` | `setSong` | 386, 436–442 |
| Default bars (vibes mode) | `sequencer/Sequencer.cpp` | `getDefaultSegmentBars` | 693–850+ (uses `rand()%10`, effective seed 1) |
| **Tonal note iteration/timing** | `instruments/TonalInstrument.h` | `processSegment` | 78–189 |
| Chord-change note breaking | `instruments/TonalInstrument.h` | `processSegment` | 141–189 |
| Negative-time stretch | `instruments/TonalInstrument.h` | `processSegment` | 195–239 |
| **Chord parse** (string→type+root) | `music/Chord.h` | `Chord(String)` | 138–152 |
| Chord steps (semitone offsets) | `music/Chord.h` | `getChordSteps` | 307–469 |
| **Chord voicing** (chordType→octave) | `instruments/SequencerUtils.h` | `getChordNotes` | 114–158 |
| Arpeggio (simple) | `instruments/SequencerUtils.h` | `getArpeggioNotes` | 160–178 |
| noteRelative | `instruments/SequencerUtils.h` | `getRelativeNote` | 180–218 |
| EDMArpeggiator | `instruments/SequencerUtils.h` | `getEDMArpeggiatorNotes` | 343–599 |
| **Velocity humanization + RNG** | `instruments/SequencerUtils.h` | `addNoteToClip` | 636–670 (line 653: `velocity += (rng.nextInt(127)-65)/5`) |
| RNG instance (global, clock-seeded) | `instruments/SequencerUtils.h` | — | 73 |
| Sustain-tail boundary clip | `instruments/SequencerUtils.h` | `addNoteToClip` | 656–666 |
| **Drum-grid expansion** | `instruments/Drums.h` | `applyPattern` | 161–274 (32 steps/bar; `retainCharacters("0x-")`) |
| Drum fills | `instruments/Drums.h` | `applyFill` | 130–159 |
| **Sample-ID → asset** | `instruments/SamplesDownloadTask.h` | `downloadSamples` | URL `{base}/playsample/{prefix}-{id}` |
| Loop clip placement | `instruments/Loop.h` | `createSegmentClip` | 52–68 (loops = ceil(segLen/srcLen)) |
| Transition sample placement | `instruments/TransitionSample.h` | `processSegment` | 42–76 |
| Transition pattern (EDM snare roll) | `instruments/TransitionPattern.h` (90dc0f4) | `createSegmentClip` / `getPatternBarsCount` / `prepareClip` | whole file |
| Snare-roll −12 dB track volume | `sequencer/Sequencer.cpp` | `Sequencer::Sequencer` (constructor) | 170–177 |
| **Sustain tail (Synths)** | `instruments/Synths.h` | `createSegmentClip` | 54–80 (`SUSTAIN_TAIL_BEATS=2.0`; `VelocityMode::beat`) |
| Sustain tail (Bass) | `instruments/Bass.h` | `createSegmentClip` | 32–72 (long notes only, dur>0.5) |
| Octave math | `music/Note.h` | `getTransposed` | 59–65 |

## Reproducibility notes

- **RNG draw order** (for matching velocity once native is also determinised):
  global `juce::Random`, drawn per `addNoteToClip` call **only** in
  `VelocityMode::randomised` — used by **Guitar** (strums/long/short). Synths and
  Bass use `VelocityMode::beat` (no RNG draw). Draw order = instrument add order
  → segment → bar → note.
- **Chord voicing**: start note is hard-coded per chordType (e.g. "C5" for
  `oneOctaveHigh`); per-instrument `octaveAdjustment*12` applied **after** chord
  lookup.
- **Drums**: 32 steps/bar (16th-note res); abs step = `barIndex*32 + offset`.
- **Sustain**: always +2.0 beats; boundary collision shortens the *earlier* note.
- **Timeline**: 4 beats/bar everywhere; tempoSequence is the beat↔time source.

## Suggested port order (smallest oracle-validatable slice first)

1. ~~Tonal lanes with `VelocityMode::beat` (Synths, Bass, Pad, Keys) — pitch/timing
   hard-assert exact, no RNG. Needs chord parse + `getChordNotes` + tonal
   iteration + sustain tail.~~ **DONE** — `src/music/{Note,Chord}.h`, `src/Tonal.h`,
   `Resolver::resolveTonalInstrument`. Exact note-for-note (pitch/timing/velocity)
   for all 8 genres, incl. chord-breaking, overlap shortener, long/short bass split.
   The 8-genre fixtures use only `note`/`noteAbsolute`/`chord`/`noteRelative`
   (no `arpeggio`/`EDMArpeggiator` — `getArpeggioNotes` is ported but unexercised).
2. ~~Drum step lanes (`applyPattern`) — `stepHits` exact.~~ **DONE** —
   `src/Drums.h`, `Resolver::resolveDrumInstrument`. Four step tracks
   (kicks/snares/toms/rest); channels (note 48+idsIndex*2, name) + per-step hits
   match the oracle for all 8 genres. Base pattern + fills, setNote `x`/`0`
   semantics. Channel order is `unordered_map` hash order (non-portable) so the
   validator matches hits/channels by (note, name), not raw channel index. The
   fixtures use only `brainRoundtrip` overrides (reset:false → base pattern,
   type → `OverrideType::all`); the reset-true and group-filter paths are ported
   but unexercised. Mutes never appear in the fixtures (applyMuteToTrack not ported).
3. ~~Wave/sample lanes (Loop, TransitionSample) — `source` + placement exact.~~
   **DONE** — `Resolver::resolveLoopInstrument` + `resolveTransitionSamples`.
   The `Loop` track is one wave clip per present segment (full segment range);
   the shared `Sample Transitions FX` track places one clip per
   `arrangement[seg].transitions` entry at `segStart + toTime(seqStartPos/8) +
   offsetSec` for `details.duration`. Sample-ID → asset is `playsample-{id}.ogg`.
   Duplicate instrument ids are deduped first-wins (`parseInstruments`), matching
   `CasperakiEngine::addInstrument` — the fixtures ship two id-50000 `Loop`
   instruments. Validator multiset-compares wave clips per track (te `getClips()`
   order is a serialisation artifact). Match across all 8 genres: clip name,
   start/end sec, source. transitionNoise is handled by `resolveNoiseRises`.
   **transitionPattern (EDM snare roll): DONE, unit-tested** —
   `Resolver::resolveTransitionPatternInstrument` + `Mixer::buildTransitionPatternSound`,
   `test/transition_pattern_test.cpp`. One step track per instrument (named
   after it, e.g. `edmSnareDrumRoll__bridge1`), one step clip per segment whose
   transitions block matches the id (numeric `id`, or 100000 + `transitionId`):
   start `segStart + ssp/8 beats + offsetSec`, `barsCount*4` beats, barsCount =
   first channel's `0`/`x` count / 32, 32 steps/bar of 1/8 beat, hit velocity 127.
   Pattern channel c (JSON key ORDER, read from an insertion-ordered parse) plays
   `samples[c]` at `getMidiNoteNumber(note)`, PCM `playsample-<id>.ogg`. Legacy's
   channel order was the sampler's `std::unordered_map` order instead (libstdc++:
   G1 before C1), so legacy swapped the two samples; the port follows the engine
   adapter's samples[] contract. Mix: target volume of the lowLevelType
   (snareDrumsElectronic) + the −12 dB roll track volume, fxGroup `drums`. Legacy
   applied the −12 dB only to a track named exactly `edmSnareDrumRoll`, which the
   adapter's `__<segment>` suffix missed; the port applies it to every roll.
4. ~~Arp / noteRelative / EDMArpeggiator.~~ **noteRelative DONE** (step 1 —
   exercised by every genre, exact). **arpeggio / EDMArpeggiator: DONE, unit-
   tested** — no fixture `song.json` emits either type (census: only
   `note`/`noteAbsolute`/`noteRelative`/`chord`/`strum`/`fretNoise`/
   `virtualGuitarist`), so there is no oracle; `test/arpeggio_test.cpp` asserts
   exact notes derived by hand from the legacy algorithm. `getEDMArpeggiatorNotes`
   (Tonal.h, from SequencerUtils.h:343-599) is called from `buildTonalNotes` and
   `buildGuitarSegment` exactly as TonalInstrument.h:97-101 does: absolute
   starts (barIndex*4 + step), no chord breaking, event time key ignored, then
   the lane's usual sustain tail / velocity mode. `getArpeggioNotes` was fixed:
   it read the integer `octave` field as a string ("" -> base note "C" = MIDI 0).
   A targeted brain-emitted song + fresh golden would still be the stronger check.
5. ~~Guitar (`VelocityMode::randomised`).~~ **DONE** — `src/Guitar.h`
   (GuitarChord + ChordData.h + getStrumNotes/getFretNoises/getGuitarStrums +
   buildGuitarSegment) and `Resolver::resolveGuitarInstrument`. Four tracks per
   guitar (short/long tonal notes, fret noises, strums). Across the 5 guitar
   genres (ballad acoustic; brightPop/latin/organicVibes/rock electric):
   - **short/long notes** (`strum`/`chord`/`note` → tonal, split dur>0.5): pitch
     (n+name) / start beat / length beats assert EXACT; velocity is
     `VelocityMode::randomised` (clock-seeded global `juce::Random`,
     SequencerUtils.h:653) so it is NOT reproducible against the current golden —
     validated to a ±25 band (two draws around the same base), exact in Phase 2
     when the golden is regenerated from a determinised build. We draw our own
     seeded RNG in faithful order so the engine is deterministic + Phase-2-ready.
   - **fret noises** (`fretNoise` → `getFretNoises`): n = `sounds[i]`, velocity
     from data — EXACT.
   - **strums** (`virtualGuitarist` → `getGuitarStrums`): a midi clip (note =
     soundIndex+48, vel 65 — both exact) + a channel-only step clip. The sound
     index is the per-instrument first-seen order of the sample key
     (root+collapsed-suffix `_pos_type`, or fx name); step channels span
     0..maxUsedInSegment with gaps padded `(60,"")` — te StepClip::insertNewChannel
     appends, so a slot is real only when first reached as a new maximum. A strum
     whose key is not in `virtualGuitaristSamples` makes ensureSampleMidiNote
     throw, and that throw is caught per (instrument, segment)
     (Sequencer.cpp:473-477), ABORTING the rest of that segment's strum loop — so
     e.g. brightPop (ships only four `chordShortStrumDown` chords) keeps just the
     first strum of each segment.
   - **negative-time stretch** (TonalInstrument.h:195-239): strum time offsets are
     slightly negative, so the clip start moves earlier (endSec unchanged) and all
     notes/strums shift to land the earliest at beat 0.
