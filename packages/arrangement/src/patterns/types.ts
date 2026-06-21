// Brain-internal pattern types.
//
// Mirrors @casperaki/song-schema's note-event shape so step 8 can drop
// these straight into Song.arrangement.overrides[<segment>][<family>].
// We re-export NoteEventSchema from song-schema rather than redefine it
// — there's only one source of truth for note shape.

import { z } from 'zod';

import {
  BarBeatSchema,
  NoteEventSchema,
  type NoteEvent,
} from '@casperaki/song-schema';

import { InstrumentFamilySchema, type InstrumentFamily } from '../selection/types.js';

export { NoteEventSchema };
export type { NoteEvent };

/** One bar's worth of notes — BarBeat key → simultaneous events at that beat. */
export const BarPatternSchema = z
  .object({
    notes: z.record(BarBeatSchema, z.array(NoteEventSchema)),
  })
  .strict();
export type BarPattern = z.infer<typeof BarPatternSchema>;

/** A single family's emission for a segment: one BarPattern per bar. */
export const FamilyPatternSchema = z
  .object({
    bars: z.array(BarPatternSchema),
  })
  .strict();
export type FamilyPattern = z.infer<typeof FamilyPatternSchema>;

/**
 * Per-segment patterns keyed by LANE display name (docs/58i lane model).
 * Each active lane in the segment maps to its emitted FamilyPattern. Inactive
 * lanes are absent — never an empty FamilyPattern, never a zero-bar bars list.
 * The lane name (e.g. `Keys`, `Guitar`, `Guitar 2`, `PopStrings`) is the same
 * key the orchestrator uses for `instrumentDefinitions` + per-segment
 * `instruments`/`overrides`.
 */
export const SegmentPatternsSchema = z
  .object({
    segmentName: z.string().min(1),
    lanes: z.record(z.string().min(1), FamilyPatternSchema),
  })
  .strict();
export type SegmentPatterns = z.infer<typeof SegmentPatternsSchema>;

export const PatternResultSchema = z
  .object({
    segments: z.array(SegmentPatternsSchema),
  })
  .strict();
export type PatternResult = z.infer<typeof PatternResultSchema>;

export { InstrumentFamilySchema };
export type { InstrumentFamily };
