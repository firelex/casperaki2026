# 20 — The song data format (brain ↔ engine contract)

> This is the single most reusable asset in the codebase: the JSON document the
> **brain generates** and the **engine renders**. Preserve and modernize it; build
> the rebuild around it. Source of truth: the engine's `Sequencer` (what it actually
> parses) cross-checked against the brain's `songs.details` JSONB.

## Two envelopes, one shape

The brain persists song data in Postgres (`songs.details`) with a few extra
production fields; the engine consumes a slightly trimmed `song.json` plus separate
`inst-*.json` instrument definitions. The musical core is identical. The rebuild
should define **one canonical schema** (ideally a shared TypeScript type + Zod
schema) and treat both legacy shapes as serializations of it.

## Top level

Field naming policy for the rebuild: **`bpm` is the only canonical field name**.
Legacy fixtures may contain `tempo`; adapters may accept it as an input alias and
log a diagnostic, but new brain, engine, frontend, and model code should emit
`bpm` only.

```jsonc
{
  "title": "songname",
  "key": "Fm",            // harmonic key
  "bpm": 134,             // beats per minute
  "genre": "edm",         // edm | ballad | rock | pop | latin | urban | schlager | ...
  "producer": "casperaki",// style persona (brain only)
  "songStructure": [ /* segment list, brain-side */ ],
  "arrangement": { /* per-segment instrument data — the heart of it */ },
  "patterns":     [ /* optional core/pattern library */ ]
}
```

## Segments

`arrangement` is keyed by segment name (`intro`, `verse`, `chorus`, `break1`,
`outro`, …). Each segment:

```jsonc
{
  "instruments": { "Drums": true, "Bass": false },   // which are active here
  "overrides":   { /* per-instrument note/bar data, keyed by display name */ },
  "fills":       { /* drum fill patterns at bar positions */ },
  "mutes":       { /* mute regions */ },
  "signalProcessors": { /* automation: filter/EQ sweeps */ },
  "transitions": { /* transition FX placements */ }
}
```

### Instrument override (notes)

```jsonc
"Bass": {
  "type": "onTheBeat157",          // override/pattern label
  "reset": true,
  "bars": [
    { "notes": {
        "0.0":  [ { "type": "note", "note": "c2", "duration": 0.5 } ],
        "0.75": [ { "type": "note", "note": "c2", "duration": 0.5 } ]
    } }
  ]
}
```

Note keys are **beat positions within the bar** (`"0.0"`, `"2.5"`, …); the value is
an array of note events (chords/stacks allowed).

### Note event "types" (resolved by the engine)

```jsonc
{ "type": "note",         "note": "c2", "duration": 0.5 }
{ "type": "chord",        "chord": "Dm", "chordType": "oneOctaveMid", "duration": 4 }
{ "type": "noteRelative", "chord": "C", "distanceFromMiddleC": -3, "duration": 0.25 }
{ "type": "EDMArpeggiator","chord": "C", "arpeggioType": "down",
  "arpeggioRhythm": "eighthNotes332", "numberOfOctaves": 2, "duration": 0.25 }
{ "type": "virtualGuitarist", "chord": "C", "duration": 1 /* + strum params */ }
```

Vocal notes additionally carry lyric/phoneme data:

```jsonc
{ "note": 60, "duration": 1, "fullWord": "Hello",
  "vocaloidPhonemes": ["h","e"], "endOfPhrase": false }
```

### Drum fills (ASCII grid)

```jsonc
"fills": { "Drums": { "patterns": {
  "patternFourthBar":      { "clap": "-------- -------- 0000x000 0000x000" },
  "patternEndOfSegment":   { "clap": "-------- -------- 0000x0x0 0000x0xx" }
} } }
```

Each string is a per-32nd-note grid (`x` = hit, `-`/`0` = rest), per drum element.

### Signal processors (automation)

```jsonc
"signalProcessors": { "Drums": {
  "type": "lowPassFilter1000SweepUp",
  "lowPassFilter": [ { "pointIn32ndNotes": 0,  "value": 1000 },
                     { "pointIn32ndNotes": 32, "value": 30000 } ]
} }
```

## Instrument definitions (`inst-*.json`)

The engine resolves each instrument named in `arrangement` to a concrete instrument:

```jsonc
{
  "id": 38954,
  "name": "diamondLoopzMood - Pad-2",
  "shortName": "pad",
  "type": "synthsSoftPad",       // customInstrument | bass | drums | ...
  "lowLevelType": "synthsSoftPad",
  "instrumentGroup": "synths",   // synths | drums | bass | keys | fx | ...
  "isVst": true,  "isSample": false,
  "vstPlugin": "diamondLoopzMood - Pad-2 - 99",
  "details": { "bpm": "99", "duration": 2.46, "LUFS": -23.5, "LRA": 4.2,
               "octaveAdjustment": null, "GMProgramNumber": 0 },
  "samples": [ { "id": 27399, "type": "longNote", "note": "C4",
                 "file": "path/to/sample.mp3" } ],   // bass/synth/guitar sample maps
  "ids": { "bassDrum1": 26997, "snareDrum1": 27128, "hiHatClosed1": 27399 } // drum map
}
```

- `lowLevelType` is the join key the brain uses to **select** instruments from its
  catalog (Postgres `Instruments`), and the engine uses to **load** samples/VSTs.
- `samples[].type` (`longNote`/`shortNote`) and `ids.*` map note data onto specific
  audio/VST sources.

## Chord & note primitives

- **Chords:** strings like `Am`, `Cmaj7`, `F#m7b5` (40+ types). Engine (`music/Chord.h`)
  resolves them to chord tones via semitone intervals against the song key.
- **Notes:** MIDI 0–127, string form `C4`/`A#5`/`Db3`. `noteRelative` offsets from
  middle C so a line can follow the chord track.

## Rebuild guidance

1. **Codify the schema.** Write a canonical `song` type (TS + Zod) in a shared package.
   Generate JSON Schema for cross-language validation (the engine is C++).
2. **Versioning.** Add a `schemaVersion`. The legacy data has no version; pin v1 to
   "what the `Sequencer` parses today" so the existing engine keeps working.
3. **One source of truth.** Brain emits canonical `song`; a thin adapter serializes to
   the exact bytes the current engine expects until the engine is updated to read
   canonical directly.
4. **Keep instrument selection server-side.** `lowLevelType`→instrument resolution is
   brain logic; the engine should receive already-resolved `inst-*` definitions.
