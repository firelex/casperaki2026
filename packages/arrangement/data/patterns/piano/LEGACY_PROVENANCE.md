# Piano pattern banks — legacy provenance

## `edmSynthsPluckPatterns.json`

- **Source**: `casperaki2-engine-js/api/v1.0/services/classes/patterns/pianoPatterns/edmSynthsPluckPatterns.json`
- **Copied verbatim** (no shape modification).
- Buckets: `ballad / edm / latin / brightPop / organicVibes / rock /
  schlager / urban`. Of these, only the `edm` bucket has rows (9
  patterns); the others are empty arrays. Legacy
  `LibraryPianoPatternGeneratorClass.js:43` ALWAYS reads the `edm`
  bucket regardless of the song's genre — the per-genre keys are
  dead structure.
- Used by `style: 'edmSynthsPluckedLibrary'` (the legacy
  `SynthPatternGenerator` route for `EDMSynthsPlucked` and for the
  `synths/synthsPlucked` lowLevel — which legacy
  `ArrangementsClass.js:131-134` forces onto this style).

## `edmSynthsStabsPatterns.json`

- **Source**: same legacy directory.
- **Copied verbatim**.
- Same bucket layout: `edm` has 5 patterns, all other buckets empty.
- Used by `style: 'edmSynthsStabsLibrary'` (`EDMSynthsStabs` synth
  style).

## Pattern shape

Each row carries:

```jsonc
{
  "name": "EDM/Synths plucked/1/Pluck Pattern 1.mid",
  "bpm": 120,
  "leftHandNotes":  { "<absoluteHit>": [{position, duration}, ...] },
  "rightHandNotes": { "<absoluteHit>": [{position, duration}, ...] }
}
```

- `absoluteHit` is a beat position relative to bar 0 (`0.0`, `0.75`,
  `1.5`, …, up to `15.75` for a 4-bar pattern).
- `position` is a signed integer offset from middle C in
  semitones — the legacy `_addNoteRelative` writes
  `distanceFromMiddleC: position + adjustment` where `adjustment` is
  the polyphonic-mode octave-centering correction.
- `duration` is in beats.

The engine's `SequencerUtils.h::getRelativeNote:175-186` reads
`distanceFromMiddleC` and snaps the resulting `Note{60 +
distanceFromMiddleC + octaveAdjustment*12}` to the current chord's
nearest note via `currentChord.findNotes(...)` (the brain's `chord`
field on the event is ignored — engine uses `currentChord` from the
segment chord progression). Per-step note duration carries through
verbatim.

## Legacy `LibraryPianoPatternGeneratorClass.createPianoPattern` rules

Ported by `packages/arrangement/src/patterns/piano-bank.ts`:

1. **BPM adjustment.** Pattern bpm vs song bpm picks an
   `adjustmentFactor` of `0.5`, `1`, or `2` (lines 68-86). Hit
   positions are scaled by this factor before per-bar splitting.
2. **Per-bar split.** `bar = floor(hit * adjustmentFactor / 4.0)`
   and `beatInBar = (hit * adjustmentFactor) % 4.0`.
3. **`monophonic` mode** (`true`): emit only the FIRST note per hit,
   from rightHandNotes ONLY; NO octave-centering adjustment.
4. **Polyphonic mode** (default): emit every note from BOTH
   leftHandNotes and rightHandNotes. Apply octave-centering:
   `adjustment = -12 * round(averagePosition / 12)`.
5. **`stabs` mode** (`true`): clamp every emitted note's duration to
   `Math.max(0.25, Math.min(0.25, original))` = literally `0.25`
   (the legacy double-clamp is preserved — its only effect is
   forcing 0.25 regardless of input).
6. **Genre `durationAddOn`**: `ballad / rock` → +1 beat; `urban` →
   +0.5 beats; everything else → 0. Applied BEFORE the stabs clamp.

## Lane scope

- **EDMSynthsPlucked**: leadSynths synth-style pool member; reads
  `edmSynthsPluckPatterns.json#edm` (poly, no stabs).
- **EDMSynthsStabs**: leadSynths synth-style pool member; reads
  `edmSynthsStabsPatterns.json#edm` (poly, no stabs at the LIBRARY
  level — the `stabs` flag is set per-style in the broader synth
  generator and is OFF for EDMSynthsStabs per the legacy switch).
- **synths/synthsPlucked**: separate brain role, ALWAYS uses style
  `edmSynthsPluckedLibrary` (legacy `ArrangementsClass.js:131-134`
  forces this on the synthsPlucked lowLevel).

## Deferred (not imported)

- **`altPatterns.json`** (8.5 MB, 2302 'pop' bucket patterns). Used
  by `altLibrary` style for `keyboardMonophonic` /
  `keyboardMonophonicRhythmic` / `keyboardPolyphonic`. The legacy
  brightPop synth style pool does NOT include those keyboard styles
  — they only fire for `organicVibes` and `schlager` genres. Defer
  until a non-brightPop slice exercises them.
- **`patterns.json`** (16 MB). Used by `library` style (the `keys`
  per-genre piano lane). Today's brain Keys/Pad emission uses a
  deterministic chord-comp / hold pattern (53y / 53x); the legacy
  `library` style would re-derive from this bank — out of scope
  here.
- **EDM / chordsStraight / chordsMixed / arpeggio / playful**: each
  needs a dedicated sub-generator port. Out of scope.
