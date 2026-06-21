// Selection types + Zod schemas.
//
// The selection result is the brain-internal contract step-6 pattern
// generators consume — it lives in @casperaki/arrangement, not in
// @casperaki/song-schema, because pattern emission lowers it into a full
// Song shape downstream.
//
// docs/58i — lane-oriented selection model (port of legacy
// `patterns.js getPattern` + `ArrangementsClass.js:578-739`). A LANE is one
// selected instrument: a stable display name + its catalog family +
// lowLevel + the picked row. Unlike the previous role-bundle model (exactly
// one entry per fixed `InstrumentFamily` role), the roster is now a
// probabilistic per-song list of N lanes that MAY repeat a family (e.g.
// rock's two electric guitars). `InstrumentFamily` is retained purely as
// the lane's catalog-family CLASSIFIER (used for pattern-generator dispatch
// + engine routing), not as a uniqueness key.

import { z } from 'zod';

import { ValidatedCatalogEntrySchema } from '../catalog/validated-catalog.js';

export const InstrumentFamilySchema = z.enum([
  'drums', 'bass', 'keys', 'pad', 'guitar', 'synths', 'pluckedSynths',
  // docs/58 — orchestral pop strings + brass (route through Synths.h).
  'popStrings', 'popBrass',
]);
export type InstrumentFamily = z.infer<typeof InstrumentFamilySchema>;

/** One selected instrument lane. The roster is an ordered list of these
 *  (the probabilistic per-song combination rolled by `rollRoster`).
 *
 *  - `lane` — stable, UNIQUE display name within the song. The family base
 *    name (`Drums`/`Bass`/`Keys`/`Pad`/`Guitar`/`Synths`/`PluckedSynths`/
 *    `PopStrings`/`PopBrass`) with a ` 2`, ` 3` suffix when a family carries
 *    more than one lane. This is the arrangement/override/instrumentDefinition
 *    key the orchestrator + engine route on.
 *  - `family` — the catalog family CLASSIFIER (pattern-generator dispatch +
 *    engine FX routing). Not a uniqueness key — lanes may share a family.
 *  - `lowLevel` — the picked row's catalog lowLevel (engine `type`/
 *    `lowLevelType`).
 *  - `essential` — legacy "always-on" lane (Drums, Bass, and the mandatory
 *    soft pad). Essentials are active in every segment; non-essentials are
 *    subject to the per-segment drop/add rule (legacy
 *    `ArrangementsClass.js:611-738`).
 *  - `perSegment` — a lane introduced by the per-segment "add one" rule
 *    (legacy `_addInstrument`), NOT part of the base roster roll. These join
 *    `instrumentDefinitions` but activate only on the specific non-chorus
 *    segments that added them — the chorus uses the base roll only
 *    (`allInstrumentsUsedInPattern`), so a `perSegment` lane can appear in a
 *    verse yet be absent from the chorus.
 *  - `pickSource` — `'genre'` when the picked row carries the song's genre
 *    in `mainStyle`/`addStyles`; `'fallback'` for the EXPLICITLY tracked
 *    any-genre fallback (legacy selected tonal SAMPLES from the full pool,
 *    only PREFERRING genre-tagged rows — `ArrangementsClass.js:64-198`).
 *    Mirrors {@link SelectedLoopSchema}'s flag. */
export const SelectedInstrumentSchema = z
  .object({
    lane: z.string().min(1),
    family: InstrumentFamilySchema,
    lowLevel: z.string().min(1),
    entry: ValidatedCatalogEntrySchema,
    essential: z.boolean().default(false),
    perSegment: z.boolean().default(false),
    pickSource: z.enum(['genre', 'fallback']).default('genre'),
  })
  .strict();
export type SelectedInstrument = z.infer<typeof SelectedInstrumentSchema>;

/** Per-segment activity: which lanes play during this segment, by lane
 *  name (a subset of the roster's `lane` values). `loopActive` is a
 *  separate flag because the percussion loop is an orthogonal sample-based
 *  lane (see {@link SelectedLoopSchema}) governed by the legacy
 *  `ArrangementsClass.js:681-708` verse-only rule for the genres in
 *  `LOOP_GENRES` (docs/54r). */
export const SegmentActivitySchema = z
  .object({
    segmentName: z.string().min(1),
    activeLanes: z.array(z.string().min(1)),
    loopActive: z.boolean().default(false),
  })
  .strict();
export type SegmentActivity = z.infer<typeof SegmentActivitySchema>;

/** Picked percussion-loop catalog entry plus the display name the engine
 *  will route per-segment activation against. The loop is OPTIONAL in
 *  the selection result — the legacy rule only activates a loop on
 *  the percussion-friendly genre set (see `LOOP_GENRES`) AND when the
 *  catalog has at least one validated row at (or fallback-near) the
 *  song's bpm. Otherwise this field is absent and the orchestrator
 *  emits no Loop instrument. (docs/54r) */
export const SelectedLoopSchema = z
  .object({
    displayName: z.string().min(1),
    entry: ValidatedCatalogEntrySchema,
    /** 'genre' — picked from rows tagged with the song's genre.
     *  'fallback' — no genre-tagged rows at the requested bpm, picked
     *  from any-genre rows at the bpm (catalog-vs-disk drift policy:
     *  docs/54r §"Loop catalog drift"). */
    pickSource: z.enum(['genre', 'fallback']),
  })
  .strict();
export type SelectedLoop = z.infer<typeof SelectedLoopSchema>;

export const SelectionResultSchema = z
  .object({
    instruments: z.array(SelectedInstrumentSchema),
    segments: z.array(SegmentActivitySchema),
    /** Percussion-loop entry chosen per the legacy
     *  `ArrangementsClass._addInstrument({instrumentGroup: 'percussion'})`
     *  rule (docs/54r). Absent when (a) the song's genre isn't in the
     *  legacy allow-list, (b) no validated catalog row matches the
     *  song bpm, or (c) the validated catalog isn't loaded at all. */
    loop: SelectedLoopSchema.optional(),
  })
  .strict();
export type SelectionResult = z.infer<typeof SelectionResultSchema>;

// AssetResolverInput moved to ../catalog/asset-resolver.ts in 53s — the
// asset resolver pass landed there. Re-exported from the package barrel
// in src/index.ts so consumers keep their import site.
export type { AssetResolverInput } from '../catalog/asset-resolver.js';
