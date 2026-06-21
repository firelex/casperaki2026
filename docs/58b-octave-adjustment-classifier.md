# 58b — Sound-parity audit: per-instrument octave adjustment

Status: classifier ported per-instrument (legacy-faithful), ran over all
286 tonal catalog rows, persisted as
`apps/engine-spike/out/octave-adjustment-per-row.json`. Per-render rollup
(`octave-adjustment-aggregated.json`) was a stepping-stone — superseded
because it covered only 8 of 286 tonal rows (the matrix's brain
selections) and the per-`lowLevelType` collapse was misleading (within
a single lowLevelType, individual instrument recordings can disagree:
`bassesElectric` had +0×1, +1×2, +2×7 across its 10 rows in a 30-row
sanity sample). Adapter wiring deferred to 58c. No engine binary changes
in this slice. Predecessor: 58a (piano-sustain audit + let-ring fix
landed; user flagged "less balanced than legacy" in the 58a wrap; LUFS
plumbing investigated and ruled out as the cause).

## Hypothesis

> Tonal instruments occasionally play in the wrong octave because the
> brain/adapter emits `details.octaveAdjustment: null` for every
> instrument; the engine reads null as 0, skipping the per-instrument
> pitch transpose that the legacy DB carried.

Confirmed.

## Map of the regression

**Legacy data flow** (reconstructed from `firelex/casperaki1` +
`casperaki2-engine-js`):

1. `casperaki1/calculateOctaveAdjustmentsAndSaveToDatabase.js` ran once
   per instrument during catalog import. It downloaded each
   instrument's C3 multisample slot, ran
   `sonic-annotator -d vamp:pyin:yin:f0 -w default <wav>`, voted the
   tracker's median F0 into a coarse bin table (C0..C7 frequencies),
   and persisted the result into `Instruments.vstDetails.octaveAdjustment`
   in the Postgres DB.
2. At render time the legacy brain
   (`casperaki2-engine-js/HelperClass.js:89,180,218,297,376`) read
   `vstDetails.octaveAdjustment` and applied `noteIndex += adjustment*12`
   to MIDI note indices in 6 distinct pattern paths.
3. The engine (`casperaki_engine`) also consumes the field — at
   `TonalInstrument.h:27` it reads `details.octaveAdjustment` and at
   `SequencerUtils.h:108, 160, 178, 471-473` applies
   `*12` semitone transposes in `getSimpleNote`, `getArpeggioNotes`,
   `getRelativeNote`, `getEDMArpeggiatorNotes`, plus the
   highest/lowest/middleNote range computation.

**What the current rebuild does:**

- `packages/engine-adapter/src/synths.ts:62,102,159,201` and
  `guitars.ts:155,240` emit `details: { LUFS: null; octaveAdjustment: null }`
  as a literal — the TypeScript type pins it as the constant `null`.
- The brain catalog (`packages/arrangement/src/catalog/types.ts`
  `InstrumentEntrySchema`) does not model `octaveAdjustment` at all.
- Engine consequently reads `null → 0`, no transpose applied.
- The 8-genre matrix renders still pass the rms/peak/duration gate,
  because most instruments happen to have adj=0 anyway; the
  regression bites only the families with non-zero legacy values.

## Legacy values are gone, the helper that produced them is not

The legacy Postgres DB is not in any checked-in repo — only the
Sequelize migrations + a partial console-log snapshot at
`casperaki1/instrumentsMetadata.txt` (68 instruments across 6
families). For the actual sample library we ship today, we need fresh
values.

`casperaki1/calculateOctaveAdjustmentsAndSaveToDatabase.js` (~365 lines)
does two things:

1. **Octave detection.** `sonic-annotator vamp:pyin:yin:f0` on the C3
   slot → bin-vote → integer in `{-4..+3}`. Hard-codes
   `acousticGuitars`, `electricGuitars`, `keysAcousticPiano` to 0 in
   the (commented-out) carve-out at lines 163-166; in practice the
   non-c3 guard at line 84 made all guitar/piano runs hit the
   `'Unknown' → 0` fallback path, producing the same result.
2. **LUFS measurement.** `ffmpeg -af loudnorm=I=-16:print_format=summary`
   on the same sample, parsed into LUFS/LRA/truePeak/threshold. But
   line 237 unconditionally overwrites the measured LUFS with the
   constant `'-24.0'` before persisting. Every sample in the DB had
   the same LUFS string. So the LUFS column was a *flag* ("sample is
   pre-normalized to -24 LUFS") not a per-sample measurement — and
   the LUFS half of this script is not worth porting.

Only the octave half ports.

## Port

`apps/engine-spike/scripts/classify-octave-adjustment.mjs` (new) +
`apps/engine-spike/scripts/lib/pyin_pitch.py` (new) +
`apps/engine-spike/scripts/aggregate-octave-adjustment.mjs` (new).

**Algorithm changes vs legacy:**

- pYIN runs via `librosa.pyin` (same Mauch & Dixon 2014 algorithm as
  the legacy's sonic-annotator pYIN), called per-batch from the mjs
  classifier through the existing `sam-audio/.venv` Python interpreter
  so no system packages are required.
- The legacy ran only on slots whose `note === 'c3'`. Ours picks the
  slot whose note is nearest to MIDI 48 (C3) and generalises the
  fundamental → octave calculation to any nearby note via
  `log2(detected/expected)`. The Guitar grid starts at c#3 (no exact
  c3), so this change matters: legacy effectively skipped Guitar;
  ours classifies on c#3 and gets a real value.
- Legacy bin table is kept (`classifyByLegacyBins`) but used only as
  a secondary signal. The primary signal is the log2-ratio with a
  ±0.25-octave tolerance: results outside that tolerance are returned
  as `null` (sample is detuned by a non-octave amount — not our job
  to fix), matching what the legacy bin table did implicitly via its
  narrow ±2 Hz windows.
- HPS fallback (in-process FFT + harmonic-product-spectrum, 5
  harmonics) kicks in only when librosa isn't on disk or pYIN reports
  all frames unvoiced. The pYIN path produced clean results for every
  sample in the matrix, so the fallback never fired.

**No catalog/adapter writes happen in 58b.** The classifier produces
two artefacts:

- `<renderDir>/octave-adjustment-map.json` — per-render, per-inst
  detail (slot id, slot note, detected Hz, both adjustment estimates).
- `apps/engine-spike/out/octave-adjustment-aggregated.json` — rolled
  up across all 8 genres, keyed by `lowLevelType` (+ `catalogId` when
  available). 58c reads this.

## Results — first cut (per-render matrix, 8 rows) — SUPERSEDED

The 8-genre matrix-driven pass classified the 8 catalog rows the brain
happened to select across the 8 genre renders. All 10 distinct
`lowLevelType`s in that sample agreed, but the user flagged — correctly
— that the legacy DB stored `octaveAdjustment` per-instrument-id, not
per-lowLevelType. A 30-row sanity probe of the catalog walker
immediately surfaced disagreement within lowLevels:

```
bassesAcoustic                           n= 3  [+0×1, +1×1, +2×1]   ← every row different
bassesElectric                           n=10  [+0×1, +1×2, +2×7]
bassesSynth808                           n= 7  [+2×7]
bassesSynthDistorted                     n=10  [+0×1, +2×9]
```

Within-lowLevel disagreement is real. The per-render aggregator's
`byLowLevelType` rollup was n=1 per cell — the "agree" flag was
vacuously true. Treat that first artefact as proof-of-pipeline only;
the per-row table below is the substantive result.

## Results — catalog walker (286 rows, per-instrument)

Per-row table at
`apps/engine-spike/out/octave-adjustment-per-row.json`, keyed by
`catalogId`. Per-lowLevel distribution summary is included in the same
file under `summaryByLowLevel` and printed at the tail of the script's
stderr output for human eyes.

Detection algorithm matches the legacy: librosa.pyin (= the algorithm
behind `sonic-annotator vamp:pyin:yin:f0`) on the canonical preset
recording → median F0 → log2(detected/130.8128) → octave-rounded
adjustment, with a ±0.25-octave tolerance that returns "Unknown" (per
the legacy → 0 default) when the detune isn't a clean octave (e.g. a
fifth-detuned preset). The legacy script ran on the C3 multisample
slot; the equivalent here is the catalog row's canonical preset MP3,
since `stage-tonal.mjs` stamps the same canonical bytes into every
multisample slot and the engine sampler does the pitch mapping.

## What happens if we land the values now (preview)

For an `adj=+1` instrument like Bass (bassesSynthSoft): the engine's
`getRealNotes` currently produces a MIDI sequence rooted at MIDI 36
(C2 — the natural bass register). With +1 plumbed,
`SequencerUtils.h:178`'s `noteData["distanceFromMiddleC"] + 12`
shifts every Bass note up by 12 semitones to MIDI 48 (C3). The Bass
*sample* itself plays at C2 (pYIN detected 65.93 Hz at the c3 slot),
so the audible result is the bass note one octave higher than today —
which is what the legacy emitted, and what the catalog row's preset
was designed for. The other +1 lanes (Lead Synths) move analogously.

Adj=0 instruments (Keys / Pad / Guitar / synthsBright/Plucked/SoftPad)
are unchanged. So the matrix-wide audible delta is bounded to ~4
families.

## Deferred — 58c

Adapter plumbing + matrix validation:

1. Add `octaveAdjustment?: number` to the brain catalog row schema
   (`packages/arrangement/src/catalog/types.ts`).
2. Backfill: read `octave-adjustment-aggregated.json`, write the
   `byLowLevelType` table into the catalog's data files (a small
   `catalog/octave-adjustment-overrides.json` keyed by lowLevelType
   is the lowest-touch path; an `octaveAdjustment` column on the row
   schema lets it propagate per-row if any single lowLevel ever needs
   different values).
3. Plumb through `synths.ts`, `guitars.ts`, and the equivalent
   Bass/Keys/Pad inst-builders so each emitted `inst-N.json` carries
   `details.octaveAdjustment: <number>` instead of `null`.
4. Re-render the 8-genre matrix:
   - 17/17 plugin tests must pass.
   - 8/8 matrix --plugins-on must pass; |Δrms| ≥ 0.05 dB.
   - rms shift bounded to the 4 non-zero lanes; per-genre dry rms is
     allowed to move by the ±2-3 dB you'd expect from re-pitching a
     few lanes into their intended register.
5. Doc at `docs/58c-octave-adjustment-render.md`.

## Out of scope for 58b (confirmed)

- LUFS plumbing (the legacy LUFS column is a constant `'-24.0'` — not
  worth carrying).
- Per-song/per-segment `overrideOctaveAdjustment` (the legacy
  `instrumentOverrides` DB table). Deferred until any song's
  arrangement actually needs it.
- Drum `preshift` parity (`Drums.h:511` reads `preshift` for each
  drum sub-instrument). Adapter already plumbs drum LUFS;
  preshift coverage is a separate audit.
- Re-tuning catalog rows for any sample whose detected pitch was
  detuned by a non-octave amount (e.g. PluckedSynths' c3 slot
  measuring 197.55 Hz — a perfect-fifth offset). Treated here as
  detuning, not octave error.

## Files touched by this slice

- `docs/58b-octave-adjustment-classifier.md` (this file, new)
- `apps/engine-spike/scripts/classify-octave-adjustment.mjs` (new)
- `apps/engine-spike/scripts/lib/pyin_pitch.py` (new)
- `apps/engine-spike/scripts/aggregate-octave-adjustment.mjs` (new)
- `apps/engine-spike/out/octave-adjustment-aggregated.json` (new
  artefact — 58c input)
- `apps/engine-spike/out/all-genre-render-smoke/<genre>/octave-adjustment-map.json`
  (new artefacts, 8 of them — one per genre)
