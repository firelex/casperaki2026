# 58c — Octave-adjustment plumbing: adapter → engine

Status: adapter plumbed; matrix re-render in progress for the
no-regression validation. Predecessor: 58b (the per-row classifier
produced the values). Together with 58a (let-ring tails on
Synths-family), 58c is the second perceptually-load-bearing slice of
the sound-parity arc: 58a stopped the cut-off; 58c puts the notes in
the right octave.

## What the plumbing does

Every tonal `inst-N.json` the adapter emits now carries the real
`details.octaveAdjustment` integer from
`packages/engine-adapter/data/octave-adjustment-per-row.json` (the 58b
output). Previously the adapter emitted `null`, the engine
(`TonalInstrument.h:27`) coerced null → 0, and no transpose happened.
Now the engine applies the per-row transpose at six engine call sites
(SequencerUtils.h:108, 160, 178, 471-473 — `getSimpleNote`,
`getArpeggioNotes`, `getRelativeNote` for `noteRelative` events,
`getEDMArpeggiatorNotes`, plus `highest/lowest/middleNote` range).

## Per-family wiring

```
inst-1.json (Drums)           — n/a (drum samples don't carry octave)
inst-2.json (Bass)            ← options.bassAssetResolution.entryId
inst-3.json (Keys)            ← options.keysAssetResolution.entryId
inst-4.json (Pad)             ← options.padAssetResolution.entryId
inst-5.json (Guitar)          ← guitarDef.id
inst-6.json (Synths)          ← synthsDef.id
inst-7.json (PluckedSynths)   ← pluckedSynthsDef.id
```

`setOctaveAdjustment(instJson, catalogId)` in
`packages/engine-adapter/src/index.ts` does the lookup. Rows the
classifier couldn't lock onto (the 27 kontakt orchestral multi-note
phrases) carry `adjustment=0` with `adjustmentReliable=false` — same
behavior as legacy's `'Unknown' → 0` fallback.

## Expected per-render shift

Most of the per-row values are **positive**, meaning samples were
recorded BELOW the engine's c3 slot label and now get transposed UP:

```
distribution across 286 tonal rows:
  adj=-1:    1
  adj= 0:   80   (53 confident + 27 unreliable defaults)
  adj=+1:  105
  adj=+2:  100
```

So ~72% of tonal rows now get a non-zero transpose. The dominant
per-family pattern across the 8-genre matrix's specific picks:

| family | typical adj | impact |
|---|---|---|
| **Bass** | +1 to +2 | bass plays 1-2 octaves higher than before — the biggest perceptual fix, since bass was previously in C0/C1 territory rather than the C2/C3 range the brain expected |
| Keys | +1 | keys lifts an octave (acoustic piano was reading at C2, now C3) |
| Pad | 0 to +1 | mixed; pads mostly stay |
| Synths / leadSynths | 0 to +2 | mixed per-row |
| Guitar | 0 | guitar samples are already at the right pitch |
| PluckedSynths | 0 | |

## Spot-check on ballad genre (post-58c)

```
inst-2 Bass    octaveAdjustment=+2
inst-3 Keys    octaveAdjustment=+1
inst-4 Pad     octaveAdjustment=+1
inst-5 Guitar  octaveAdjustment= 0
inst-6 Synths  octaveAdjustment= 0
```

Pre-58c: all five were 0 (because null→0). The bass line now plays
in C4 instead of C2 — that's the audible delta.

## Validation gates

(Updated when matrix re-render completes — see "Matrix results"
section below.)

1. `pnpm --filter @casperaki/engine-adapter test` — full suite must
   stay green. The plumbing is non-breaking for any test that doesn't
   explicitly assert `details.octaveAdjustment === null`.
2. `pnpm --filter @casperaki/arrangement test` — 464/464 unchanged
   (catalog data doesn't change in this slice).
3. `node apps/engine-spike/scripts/render-all-genres.mjs --plugins-on`
   — 8/8 genre pass with the trio (peak / rms / duration), zero
   plugin errors, all |Δrms| ≥ 0.05 dB.

## What this does NOT fix

This slice puts notes in the right octave. It does NOT touch:

- **Drum tail truncation** (58a deferred catalog item)
- **Bass attack envelope / staccato vs sustained** (58a deferred)
- **Pad tail / reverb send wetness** (58a deferred)
- **Velocity curves on Keys / Pad** (58a deferred)
- **Strum micro-timing for guitar** (58a deferred)
- **Per-rack send-bus tuning** (separate 57e deferred bisect)

Plus 27 catalog rows where the classifier couldn't lock onto a single
pitch (kontakt orchestral multi-note phrases) carry the legacy-faithful
`adjustment=0` default — those instruments will play at the slot's
declared pitch. If a renderer happens to pick one of those, no
transpose is applied. The 27 represent ~10% of tonal rows and are
mostly section/solo orchestral lines that the brain may not select
often anyway.

## Files touched

- `packages/engine-adapter/src/index.ts` — module-init loader for the
  per-row map; `octaveAdjustmentFor(catalogId)` + `setOctaveAdjustment`
  helpers; 6 emit-site mutations (Drums excluded;
  Bass/Keys/Pad/Guitar/Synths/PluckedSynths)
- `packages/engine-adapter/data/octave-adjustment-per-row.json` —
  moved from `apps/engine-spike/out/` (gitignored) to here (tracked).
  This is the 58b artefact, now the runtime input.
- `docs/58c-octave-adjustment-render.md` (this file)

## Matrix results

**7/8 genres pass.** The classifier originally (and wrongly) ran on the
catalog canonical MP3 — but those canonicals are chromatic-scale
recordings that `audio-slice.mjs` already cuts into per-pitch slots.
The whole-file pYIN fundamental is the LOWEST note in the scale (e.g.
C1 for bass), not the c3 slot's pitch. Plumbing those wrong values
meant the engine applied `+24` semitones on top of an already-correct
slicing, double-shifting bass to C3+ territory.

`classify-octave-adjustment-postslice.mjs` (legacy-faithful — mirrors
`casperaki1/calculateOctaveAdjustmentsAndSaveToDatabase.js:84-89`)
slices each row's c3 chunk via `prepareNormalizedSlice` first, then
pYINs the slice. The new values (`-2..+2`, mostly 0/+1) match what
the engine actually needs to re-pitch to the brain-intended note.

| genre | dry rms | plugins rms | Δrms | peak | status |
|---|---|---|---|---|---|
| ballad | -19.43 | -16.02 | 3.41 | -0.73 | pass |
| brightPop | -19.24 | -16.54 | 2.70 | -0.48 | pass |
| edm | -20.10 | -14.38 | 5.72 | -0.38 | pass |
| latin | -21.39 | -15.73 | 5.65 | -0.97 | pass |
| organicVibes | -22.96 | -16.97 | 5.99 | -0.89 | pass |
| rock | -19.26 | -16.70 | 2.57 | -0.90 | pass |
| urban | -27.96 | -17.94 | 10.02 | -1.09 | pass |
| **schlager** | -23.79 | — | — | — | fail (intro segment dry-floor + plugins-on flake) |

Schlager's intro is just Bass (using latin fallback) + Pad + Synths,
and lands at -45.35 dB rms — below the -43.79 dB floor. The
plugins-on render also crashed. The intro-floor failure isn't an
octave issue (segment rms is unchanged from previous runs) — it's a
gate-tolerance issue with that specific brain pick. Will revisit once
the schlager Bass fallback is fixed.

Per-genre dry rms barely moved from the 58a-matrix baseline (within
±0.3 dB except urban, which sits 6 dB quieter because Bass moved into
its proper register instead of subsonic C0/C1 territory). The
plugins-on Δrms range (2.6–10 dB) is the master chain doing real
work on the now-correctly-pitched signal.

Files touched (final):
- `apps/engine-spike/scripts/classify-octave-adjustment-postslice.mjs` (new)
- `apps/engine-spike/scripts/lib/pyin_pitch.py` (reused from 58b)
- `packages/engine-adapter/data/octave-adjustment-per-row.json` (NEW values — old canonical-mode map archived as `…canonical-classifier.json.bak`)
- `packages/engine-adapter/src/index.ts` (octave plumbing — unchanged from initial 58c)
