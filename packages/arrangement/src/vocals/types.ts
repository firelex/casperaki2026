// Brain-internal vocal types.
//
// Mirrors @casperaki/song-schema's `VocalNoteEvent` shape exactly so
// step 8 can drop these straight into a vocal instrument override
// without translating event shape.

import { z } from 'zod';

import {
  BarBeatSchema,
  VocalNoteEventSchema,
  type VocalNoteEvent,
} from '@casperaki/song-schema';

export { VocalNoteEventSchema };
export type { VocalNoteEvent };

/** One bar's vocal events keyed by BarBeat. */
export const VocalBarSchema = z
  .object({
    notes: z.record(BarBeatSchema, z.array(VocalNoteEventSchema)),
  })
  .strict();
export type VocalBar = z.infer<typeof VocalBarSchema>;

/** Per-segment vocal emission. Segments without vocals are absent from
 *  `VocalResult.segments`, never present-with-empty-bars. */
export const VocalSegmentSchema = z
  .object({
    segmentName: z.string().min(1),
    bars: z.array(VocalBarSchema),
  })
  .strict();
export type VocalSegment = z.infer<typeof VocalSegmentSchema>;

/** Brain-internal vocal result. The lead is the only required field — backing
 *  lanes (`backings` = -4, `backings2` = +4) and the schlager-only support
 *  lane are additive (Step 17d, per docs/53af §3c / docs/53ah). Segments
 *  in the lead-lane track `segments` are the source-of-truth for which
 *  segments sing at all; backing arrays only carry entries for segments
 *  where the legacy activity gate fires (chorus / bridge with a lead).
 *
 *  No `Song` schema change is required: the orchestrator lowers these
 *  optional arrays into the open `arrangement[seg].overrides[<lane>]`
 *  envelope, keying with the legacy lane display names. */
export const VocalResultSchema = z
  .object({
    segments: z.array(VocalSegmentSchema),
    backings: z.array(VocalSegmentSchema).optional(),
    backings2: z.array(VocalSegmentSchema).optional(),
    schlagerSupport: z.array(VocalSegmentSchema).optional(),
  })
  .strict();
export type VocalResult = z.infer<typeof VocalResultSchema>;
